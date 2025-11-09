"""Review queue API endpoints for HITL workflow."""

from __future__ import annotations

import base64
import io
import logging
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user, require_role
from config import settings
from database import get_session
from models import Document, DocumentStatus, ReviewAction, User, UserRole
from review_service import (
    claim_document,
    get_document_audit_trail,
    get_document_by_id,
    get_review_queue,
    release_document,
    resolve_document,
)

logger = logging.getLogger(__name__)

# Create router with /admin prefix
router = APIRouter(prefix="/admin", tags=["review"])


# Response models
class DocumentResponse(BaseModel):
    """Document in review queue."""

    id: str
    original_name: str
    stored_filename: str
    applicant_name: str
    applicant_lastname: str
    category_predicted: str
    category_confidence: float
    category_final: str | None
    status: str
    assigned_reviewer_id: str | None
    uploaded_at: str
    updated_at: str
    text_excerpt: str | None = None

    @classmethod
    def from_orm(cls, document: Document) -> DocumentResponse:
        """Convert ORM model to response."""
        try:
            text_excerpt = None
            if document.text:
                text_excerpt = document.text.text_excerpt
            else:
                logger.warning(f"Document {document.id} has no text relationship")

            response = cls(
                id=document.id,
                original_name=document.original_name,
                stored_filename=document.stored_filename or "",
                applicant_name=document.applicant_name,
                applicant_lastname=document.applicant_lastname,
                category_predicted=document.category_predicted,
                category_confidence=document.category_confidence,
                category_final=document.category_final,
                status=document.status.value,
                assigned_reviewer_id=document.assigned_reviewer_id,
                uploaded_at=document.created_at.isoformat(),
                updated_at=document.updated_at.isoformat(),
                text_excerpt=text_excerpt,
            )
            return response
        except Exception as e:
            logger.error(f"Error in from_orm for document {document.id}: {e}", exc_info=True)
            raise


class ReviewActionResponse(BaseModel):
    """Review action for audit trail."""

    id: str
    document_id: str
    reviewer_email: str
    action: str
    from_category: str | None
    to_category: str | None
    comment: str | None
    duration_seconds: int | None
    created_at: str

    @classmethod
    def from_orm(cls, action: ReviewAction) -> ReviewActionResponse:
        """Convert ORM model to response."""
        return cls(
            id=action.id,
            document_id=action.document_id,
            reviewer_email=action.reviewer.email if action.reviewer else "unknown",
            action=action.action.value,
            from_category=action.from_category,
            to_category=action.to_category,
            comment=action.comment,
            duration_seconds=action.duration_seconds,
            created_at=action.created_at.isoformat(),
        )


class ResolveRequest(BaseModel):
    """Request to resolve a document."""

    final_category: str = Field(..., min_length=1, max_length=100)
    applicant_name: str | None = Field(None, max_length=200)
    applicant_lastname: str | None = Field(None, max_length=200)
    comment: str | None = Field(None, max_length=1000)


class MessageResponse(BaseModel):
    """Generic message response."""

    message: str


@router.get(
    "/review-queue",
    response_model=list[DocumentResponse],
    dependencies=[Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))],
)
async def list_review_queue(
    status: Annotated[DocumentStatus | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    session: Annotated[AsyncSession, Depends(get_session)] = None,
) -> list[DocumentResponse]:
    """
    List documents in review queue.

    Requires reviewer role.
    """
    documents = await get_review_queue(
        session=session,
        status=status,
        limit=limit,
        offset=offset,
    )
    return [DocumentResponse.from_orm(doc) for doc in documents]


@router.post(
    "/review-queue/{document_id}/claim",
    response_model=DocumentResponse,
    status_code=status.HTTP_200_OK,
)
async def claim_document_endpoint(
    document_id: str,
    current_user: Annotated[
        User, Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))
    ],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> DocumentResponse:
    """
    Claim a document for review.

    Changes status from QUEUED to IN_REVIEW and assigns to current reviewer.
    """
    try:
        document = await claim_document(
            session=session,
            document_id=document_id,
            reviewer=current_user,
        )
        return DocumentResponse.from_orm(document)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.post(
    "/review-queue/{document_id}/release",
    response_model=DocumentResponse,
    status_code=status.HTTP_200_OK,
)
async def release_document_endpoint(
    document_id: str,
    current_user: Annotated[
        User, Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))
    ],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> DocumentResponse:
    """
    Release a claimed document back to queue.

    Changes status from IN_REVIEW to QUEUED and unassigns reviewer.
    """
    try:
        document = await release_document(
            session=session,
            document_id=document_id,
            reviewer=current_user,
        )
        return DocumentResponse.from_orm(document)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.post(
    "/review-queue/{document_id}/resolve",
    response_model=DocumentResponse,
    status_code=status.HTTP_200_OK,
)
async def resolve_document_endpoint(
    document_id: str,
    resolve_request: ResolveRequest,
    current_user: Annotated[
        User, Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))
    ],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> DocumentResponse:
    """
    Resolve a document review.

    Changes status from IN_REVIEW to RESOLVED, records final category
    and reviewer actions.
    """
    logger.info(
        f"Resolve request for document {document_id} by user {current_user.email}: "
        f"final_category={resolve_request.final_category}, "
        f"applicant_name={resolve_request.applicant_name}, "
        f"applicant_lastname={resolve_request.applicant_lastname}"
    )
    try:
        document = await resolve_document(
            session=session,
            document_id=document_id,
            reviewer=current_user,
            final_category=resolve_request.final_category,
            applicant_name=resolve_request.applicant_name,
            applicant_lastname=resolve_request.applicant_lastname,
            comment=resolve_request.comment,
        )
        logger.info(f"Document {document_id} resolved successfully, creating response")

        try:
            response = DocumentResponse.from_orm(document)
            logger.info(f"Response created successfully for document {document_id}")
            return response
        except Exception as e:
            print(f"[RESOLVE] ERROR in from_orm: {type(e).__name__}: {e}")  # DEBUG
            logger.error(
                f"Error creating DocumentResponse for {document_id}: {e}",
                exc_info=True
            )
            raise

    except ValueError as e:
        print(f"[RESOLVE] ValueError: {e}")  # DEBUG
        logger.warning(f"ValueError resolving document {document_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except Exception as e:
        print(f"[RESOLVE] UNEXPECTED ERROR: {type(e).__name__}: {e}")  # DEBUG
        import traceback
        traceback.print_exc()  # Print full traceback to console
        logger.error(
            f"Unexpected error resolving document {document_id}: {e}",
            exc_info=True
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error while resolving document",
        ) from e


@router.get(
    "/documents/{document_id}",
    response_model=DocumentResponse,
    dependencies=[Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))],
)
async def get_document(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)] = None,
) -> DocumentResponse:
    """
    Get document details by ID.

    Requires reviewer role.
    """
    document = await get_document_by_id(session=session, document_id=document_id)
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Документ {document_id} не найден",
        )
    return DocumentResponse.from_orm(document)


@router.get(
    "/documents/{document_id}/audit",
    response_model=list[ReviewActionResponse],
    dependencies=[Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))],
)
async def get_document_audit(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)] = None,
) -> list[ReviewActionResponse]:
    """
    Get audit trail for a document.

    Returns all review actions ordered by creation time.
    """
    # Verify document exists
    document = await get_document_by_id(session=session, document_id=document_id)
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Документ {document_id} не найден",
        )

    actions = await get_document_audit_trail(
        session=session,
        document_id=document_id,
    )
    return [ReviewActionResponse.from_orm(action) for action in actions]


@router.get(
    "/documents/{document_id}/preview",
    dependencies=[Depends(require_role(UserRole.REVIEWER, UserRole.ADMIN))],
)
async def get_document_preview(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """
    Get document preview - returns the actual file for PDFs or JSON for images/text.

    For PDFs: Returns the actual PDF file with appropriate headers
    For images: Returns JSON with base64-encoded image data
    For text: Returns JSON with text excerpt
    """
    try:
        # Get document
        document = await get_document_by_id(session=session, document_id=document_id)
        if not document:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Документ {document_id} не найден",
            )

        if not document.stored_filename:
            logger.warning("Document %s has no stored_filename", document_id)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Документ не имеет сохраненного файла",
            )

        # stored_filename is relative to upload_folder.parent
        file_path = settings.upload_folder.parent / document.stored_filename
        logger.info(
            "Preview for document %s: stored_filename=%s, file_path=%s, exists=%s",
            document_id,
            document.stored_filename,
            file_path,
            file_path.exists(),
        )

        if not file_path.exists():
            logger.warning(
                "File not found for document %s at path: %s", document_id, file_path
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Файл документа не найден на диске: {file_path}",
            )

        # Check file extension
        ext = file_path.suffix.lower()

        # For PDFs, return the actual file
        if ext == ".pdf":
            logger.info("Serving PDF file: %s", file_path)
            # Properly encode filename for Content-Disposition header (RFC 5987)
            encoded_filename = quote(document.original_name.encode("utf-8"))
            return FileResponse(
                path=str(file_path),
                media_type="application/pdf",
                filename=document.original_name,
                headers={
                    "Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}",
                    "Cache-Control": "private, max-age=3600",
                },
            )

        # For images, return base64
        if ext in {".jpg", ".jpeg", ".png"}:
            try:
                logger.info("Loading image file: %s", file_path)
                with file_path.open("rb") as f:
                    image_bytes = f.read()
                    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

                    mime_type = (
                        "image/jpeg" if ext in {".jpg", ".jpeg"} else "image/png"
                    )

                    logger.info(
                        "Image preview generated successfully for %s", document_id
                    )
                    return JSONResponse(
                        content={
                            "type": "image",
                            "image": f"data:{mime_type};base64,{image_b64}",
                        }
                    )
            except Exception as e:
                logger.exception("Failed to read image file %s", file_path)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Не удалось прочитать изображение",
                ) from e

        # Fallback to text excerpt if available
        if document.text and document.text.text_excerpt:
            logger.info("Returning text preview for document %s", document_id)
            return JSONResponse(
                content={
                    "type": "text",
                    "text": document.text.text_excerpt,
                }
            )

        # No preview available
        logger.warning(
            "No preview available for document %s (ext=%s, has_text=%s)",
            document_id,
            ext,
            document.text is not None,
        )
        return JSONResponse(
            content={
                "type": "none",
                "message": "Предпросмотр недоступен для этого документа",
            }
        )

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        # Log and wrap unexpected exceptions
        logger.exception("Unexpected error in document preview for %s", document_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Внутренняя ошибка сервера при загрузке предпросмотра",
        ) from e


__all__ = ["router"]
