"""Authentication and authorization for FastAPI."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPBearer
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_session
from models import User, UserRole
from security import verify_password

logger = logging.getLogger(__name__)

# Create router for auth endpoints
router = APIRouter(prefix="/auth", tags=["auth"])

# Session signer for secure cookies
_signer = TimestampSigner(settings.session_secret_key)


# ============================================================================
# REQUEST/RESPONSE MODELS
# ============================================================================


class LoginRequest(BaseModel):
    """Login request body."""

    email: EmailStr
    password: str


class UserResponse(BaseModel):
    """User information response."""

    id: str
    email: str
    display_name: str
    role: str
    is_active: bool
    last_login_at: datetime | None


class LoginResponse(BaseModel):
    """Login success response."""

    user: UserResponse
    message: str = "Login successful"


class MessageResponse(BaseModel):
    """Generic message response."""

    message: str


# ============================================================================
# SESSION MANAGEMENT
# ============================================================================


def create_session_token(user_id: str) -> str:
    """Create a signed session token for the user."""
    return _signer.sign(user_id).decode("utf-8")


def verify_session_token(token: str) -> str | None:
    """
    Verify and decode a session token.

    Returns user_id if valid, None if invalid/expired.
    """
    try:
        return _signer.unsign(token, max_age=settings.session_max_age).decode("utf-8")
    except (BadSignature, SignatureExpired):
        return None


def set_session_cookie(response: Response, user_id: str) -> None:
    """Set session cookie on response."""
    token = create_session_token(user_id)
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_max_age,
        httponly=True,
        secure=False,  # Set to True in production with HTTPS
        samesite="none"
        if not settings.is_production
        else "lax",  # "none" allows CORS in dev
    )


def clear_session_cookie(response: Response) -> None:
    """Clear session cookie from response."""
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=False,
        samesite="none" if not settings.is_production else "lax",
    )


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
    # Get session cookie
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    # Verify token
    user_id = verify_session_token(token)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        )

    # Load user from database
    result = await session.execute(sa.select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is disabled",
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
                detail=f"Requires one of roles: {[r.value for r in allowed_roles]}",
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

    user_id = verify_session_token(token)
    if not user_id:
        return None

    result = await session.execute(sa.select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        return None

    return user


# ============================================================================
# AUTH ENDPOINTS
# ============================================================================


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
    # Find user by email
    result = await session.execute(
        sa.select(User).where(User.email == request.email.lower())
    )
    user = result.scalar_one_or_none()

    if not user:
        # Don't reveal if user exists
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Verify password
    if not verify_password(request.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Check if account is active
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is disabled",
        )

    # Update last login
    user.last_login_at = datetime.now(UTC)
    await session.commit()

    # Set session cookie
    set_session_cookie(response, user.id)

    logger.info("User logged in: %s (%s)", user.email, user.role.value)

    return LoginResponse(
        user=UserResponse(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            role=user.role.value,
            is_active=user.is_active,
            last_login_at=user.last_login_at,
        )
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
    logger.info("User logged out: %s", current_user.email)
    return MessageResponse(message="Logged out successfully")


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserResponse:
    """
    Get current authenticated user information.
    """
    return UserResponse(
        id=current_user.id,
        email=current_user.email,
        display_name=current_user.display_name,
        role=current_user.role.value,
        is_active=current_user.is_active,
        last_login_at=current_user.last_login_at,
    )


__all__ = [
    "LoginRequest",
    "LoginResponse",
    "MessageResponse",
    "UserResponse",
    "get_current_user",
    "get_current_user_optional",
    "require_role",
    "router",
]
