"""Authentication and authorization for FastAPI."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from itsdangerous import BadSignature, URLSafeSerializer
from pydantic import BaseModel, EmailStr
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_session
from models import User, UserRole
from security import verify_password

logger = logging.getLogger(__name__)

# Create router for auth endpoints
router = APIRouter(prefix="/auth", tags=["auth"])

# Session serializer for signed cookies
_serializer = URLSafeSerializer(settings.session_secret_key, salt="session")


# ============================================================================
# REQUEST/RESPONSE MODELS
# ============================================================================


class LoginRequest(BaseModel):
    """Login request body."""

    email: EmailStr
    password: str
    remember_me: bool = False


class UserResponse(BaseModel):
    """User information response."""

    id: str
    email: str
    display_name: str
    role: str
    is_active: bool
    last_login_at: datetime | None


class SessionInfo(BaseModel):
    """Session metadata returned to the client."""

    expires_at: datetime
    remember_me: bool


class AuthSessionResponse(BaseModel):
    """Current authenticated user alongside active session."""

    user: UserResponse
    session: SessionInfo


class LoginResponse(AuthSessionResponse):
    """Login success response."""

    message: str = "Успешный вход"


class RefreshResponse(AuthSessionResponse):
    """Session refresh response."""

    message: str = "Сессия обновлена"


class MessageResponse(BaseModel):
    """Generic message response."""

    message: str


# ============================================================================
# SESSION MANAGEMENT
# ============================================================================


@dataclass(slots=True)
class SessionData:
    """Decoded session payload."""

    user_id: str
    remember_me: bool
    expires_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


def _session_duration_seconds(*, remember: bool) -> int:
    return settings.session_remember_max_age if remember else settings.session_max_age


def create_session_token(user_id: str, *, remember: bool) -> tuple[str, SessionData]:
    """Create a signed session token for the user."""
    issued_at = _now()
    expires_at = issued_at + timedelta(
        seconds=_session_duration_seconds(remember=remember)
    )
    payload = {
        "uid": user_id,
        "remember": remember,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    token = _serializer.dumps(payload)
    return token, SessionData(
        user_id=user_id, remember_me=remember, expires_at=expires_at
    )


def verify_session_token(token: str) -> SessionData | None:
    """Verify and decode a session token."""
    try:
        payload = _serializer.loads(token)
    except BadSignature:
        logger.debug("Invalid session signature received")
        return None

    if not isinstance(payload, dict):
        logger.debug("Session payload is not a mapping")
        return None

    try:
        user_id = str(payload["uid"])
        remember = bool(payload.get("remember", False))
        expires_at = datetime.fromtimestamp(int(payload["exp"]), tz=UTC)
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning("Malformed session payload", exc_info=exc)
        return None

    if expires_at <= _now():
        logger.info("Session expired for user_id=%s", user_id)
        return None

    return SessionData(user_id=user_id, remember_me=remember, expires_at=expires_at)


def set_session_cookie(
    response: Response,
    token: str,
    *,
    remember: bool,
    expires_at: datetime,
) -> None:
    """Set session cookie on response."""
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=_session_duration_seconds(remember=remember),
        expires=expires_at,
        httponly=True,
        secure=settings.is_production,
        samesite="none" if settings.is_production else "lax",
    )


def issue_session(response: Response, user_id: str, *, remember: bool) -> SessionData:
    """Create a new session token and attach it to the response."""
    token, session_data = create_session_token(user_id, remember=remember)
    set_session_cookie(
        response,
        token,
        remember=session_data.remember_me,
        expires_at=session_data.expires_at,
    )
    return session_data


def clear_session_cookie(response: Response) -> None:
    """Clear session cookie from response."""
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=settings.is_production,
        samesite="none" if settings.is_production else "lax",
    )


def _require_session_data(request: Request) -> SessionData:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Не выполнен вход",
        )

    session_data = verify_session_token(token)
    if not session_data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Сессия недействительна или истекла",
        )

    request.state.session_data = session_data
    return session_data


# ============================================================================
# DEPENDENCIES
# ============================================================================


async def get_current_user(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    """
    Dependency to get the current authenticated user from session.

    Raises 401 if not authenticated or user not found.
    """
    session_data = _require_session_data(request)

    # Load user from database
    try:
        result = await session.execute(
            sa.select(User).where(User.id == session_data.user_id)
        )
    except SQLAlchemyError as exc:
        logger.exception("Database error while loading current user", exc_info=exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось загрузить пользователя. Попробуйте позже.",
        ) from exc
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Пользователь не найден",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Учётная запись пользователя отключена",
        )

    return user


def require_role(
    *allowed_roles: UserRole,
) -> Callable[[Annotated[User, Depends(get_current_user)]], User]:
    """
    Dependency factory to require specific user roles.

    Usage:
        @app.get("/admin/stuff", dependencies=[Depends(require_role(UserRole.ADMIN))])
        async def admin_stuff(): ...
    """

    async def check_role(
        current_user: Annotated[User, Depends(get_current_user)],
    ) -> User:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "Требуется одна из ролей: "
                    + ", ".join([r.value for r in allowed_roles])
                ),
            )
        return current_user

    return check_role


# Optional dependency - returns None if not authenticated
async def get_current_user_optional(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User | None:
    """
    Dependency to optionally get current user.

    Returns None if not authenticated instead of raising exception.
    """
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None

    session_data = verify_session_token(token)
    if not session_data:
        return None

    request.state.session_data = session_data

    try:
        result = await session.execute(
            sa.select(User).where(User.id == session_data.user_id)
        )
    except SQLAlchemyError as exc:
        logger.exception("Database error while loading optional user", exc_info=exc)
        return None
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        return None

    return user


# ============================================================================
# AUTH ENDPOINTS
# ============================================================================


def _build_user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=user.role.value,
        is_active=user.is_active,
        last_login_at=user.last_login_at,
    )


def _build_session_info(session_data: SessionData) -> SessionInfo:
    return SessionInfo(
        expires_at=session_data.expires_at,
        remember_me=session_data.remember_me,
    )


@router.post("/login", response_model=LoginResponse)
async def login(
    request: LoginRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> LoginResponse:
    """
    Authenticate user and create session.

    Returns user info and sets session cookie.
    """
    email = request.email.lower().strip()
    remember = bool(request.remember_me)

    try:
        result = await session.execute(sa.select(User).where(User.email == email))
    except SQLAlchemyError as exc:
        logger.exception("Database error while looking up user", exc_info=exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось обработать запрос. Попробуйте позже.",
        ) from exc

    user = result.scalar_one_or_none()

    if not user:
        # Don't reveal if user exists
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный email или пароль",
        )

    # Verify password
    if not verify_password(request.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный email или пароль",
        )

    # Check if account is active
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Учётная запись отключена",
        )

    # Update last login
    user.last_login_at = _now()

    try:
        await session.commit()
    except SQLAlchemyError as exc:
        await session.rollback()
        logger.exception("Failed to update last_login_at", exc_info=exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось завершить вход. Попробуйте снова немного позже.",
        ) from exc

    session_data = issue_session(response, user.id, remember=remember)

    logger.info("Пользователь вошёл: %s (%s)", user.email, user.role.value)

    return LoginResponse(
        user=_build_user_response(user),
        session=_build_session_info(session_data),
    )


@router.post("/logout", response_model=MessageResponse)
async def logout(
    response: Response,
    current_user: Annotated[User, Depends(get_current_user)],
) -> MessageResponse:
    """
    Log out current user by clearing session cookie.
    """
    clear_session_cookie(response)
    logger.info("Пользователь вышел: %s", current_user.email)
    return MessageResponse(message="Вы успешно вышли")


@router.post("/refresh", response_model=RefreshResponse)
async def refresh_session(
    request: Request,
    response: Response,
    current_user: Annotated[User, Depends(get_current_user)],
) -> RefreshResponse:
    """Refresh the current session cookie."""
    session_data = getattr(request.state, "session_data", None)
    if session_data is None:
        session_data = _require_session_data(request)

    remaining = session_data.expires_at - _now()
    if remaining <= timedelta(seconds=settings.session_refresh_lead_time):
        session_data = issue_session(
            response,
            current_user.id,
            remember=session_data.remember_me,
        )
        logger.debug(
            "Session refreshed for user_id=%s remember=%s",
            current_user.id,
            session_data.remember_me,
        )
    else:
        logger.debug(
            "Session refresh skipped (too early) for user_id=%s",
            current_user.id,
        )
    return RefreshResponse(
        user=_build_user_response(current_user),
        session=_build_session_info(session_data),
    )


@router.get("/me", response_model=AuthSessionResponse)
async def get_me(
    request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
) -> AuthSessionResponse:
    """Get current authenticated user information."""
    session_data = getattr(request.state, "session_data", None)
    if session_data is None:
        session_data = _require_session_data(request)

    return AuthSessionResponse(
        user=_build_user_response(current_user),
        session=_build_session_info(session_data),
    )


__all__ = [
    "AuthSessionResponse",
    "LoginRequest",
    "LoginResponse",
    "MessageResponse",
    "RefreshResponse",
    "SessionInfo",
    "UserResponse",
    "get_current_user",
    "get_current_user_optional",
    "require_role",
    "router",
]
