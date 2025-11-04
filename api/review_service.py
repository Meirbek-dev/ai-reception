"""Review queue service layer for HITL workflow."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models import Document, DocumentStatus, ReviewAction, ReviewActionType, User

if TYPE_CHECKING:
    from collections.abc import Sequence

logger = logging.getLogger(__name__)


async def get_review_queue(
    session: AsyncSession,
    status: DocumentStatus | None = None,
    limit: int = 50,
    offset: int = 0,
) -> Sequence[Document]:
    """
    Get documents in review queue.

    Args:
        session: Database session
        status: Filter by document status (default: queued documents)
        limit: Maximum number of documents to return
        offset: Number of documents to skip

    Returns:
        List of documents with their text content loaded
    """
    query = select(Document).options(selectinload(Document.text_content))

    # Default to queued documents if no status specified
    if status is None:
        query = query.where(Document.status == DocumentStatus.QUEUED)
    else:
        query = query.where(Document.status == status)

    # Order by upload time (oldest first for fairness)
    query = query.order_by(Document.uploaded_at.asc())
    query = query.limit(limit).offset(offset)

    result = await session.execute(query)
    return result.scalars().all()


async def claim_document(
    session: AsyncSession,
    document_id: int,
    reviewer: User,
) -> Document:
    """
    Claim a document for review.

    Args:
        session: Database session
        document_id: Document ID to claim
        reviewer: User claiming the document

    Returns:
        Updated document

    Raises:
        ValueError: If document not found, already claimed, or not in queued status
    """
    # Load document
    result = await session.execute(select(Document).where(Document.id == document_id))
    document = result.scalar_one_or_none()

    if not document:
        msg = f"Документ {document_id} не найден"
        raise ValueError(msg)

    if document.status != DocumentStatus.QUEUED:
        msg = f"Документ {document_id} не может быть принят (статус: {document.status.value})"
        raise ValueError(msg)

    if document.assigned_reviewer_id is not None:
        msg = f"Документ {document_id} уже принят другим рецензентом"
        raise ValueError(msg)

    # Claim document
    document.assigned_reviewer_id = reviewer.id
    document.status = DocumentStatus.IN_REVIEW
    document.updated_at = datetime.now(UTC)

    # Create review action
    action = ReviewAction(
        document_id=document.id,
        reviewer_id=reviewer.id,
        action=ReviewActionType.CLAIM,
        from_category=document.category_predicted,
        to_category=None,
        comment=None,
        duration_seconds=None,
    )
    session.add(action)

    await session.commit()
    await session.refresh(document)

    logger.info(
        f"Документ {document_id} принят рецензентом {reviewer.id} ({reviewer.email})"
    )

    return document


async def release_document(
    session: AsyncSession,
    document_id: int,
    reviewer: User,
) -> Document:
    """
    Release a claimed document back to queue.

    Args:
        session: Database session
        document_id: Document ID to release
        reviewer: User releasing the document

    Returns:
        Updated document

    Raises:
        ValueError: If document not found, not claimed by this reviewer
    """
    # Load document
    result = await session.execute(select(Document).where(Document.id == document_id))
    document = result.scalar_one_or_none()

    if not document:
        msg = f"Документ {document_id} не найден"
        raise ValueError(msg)

    if document.status != DocumentStatus.IN_REVIEW:
        msg = (
            f"Документ {document_id} не находится в обработке (статус: {document.status.value})"
        )
        raise ValueError(msg)

    if document.assigned_reviewer_id != reviewer.id:
        msg = f"Документ {document_id} не закреплён за этим рецензентом"
        raise ValueError(msg)

    # Release document
    document.assigned_reviewer_id = None
    document.status = DocumentStatus.QUEUED
    document.updated_at = datetime.now(UTC)

    # Create review action
    action = ReviewAction(
        document_id=document.id,
        reviewer_id=reviewer.id,
        action=ReviewActionType.RELEASE,
        from_category=document.category_predicted,
        to_category=None,
        comment=None,
        duration_seconds=None,
    )
    session.add(action)

    await session.commit()
    await session.refresh(document)

    logger.info(
        f"Документ {document_id} возвращён в очередь рецензентом {reviewer.id} ({reviewer.email})"
    )

    return document


async def resolve_document(  # noqa: PLR0913
    session: AsyncSession,
    document_id: int,
    reviewer: User,
    final_category: str,
    applicant_name: str | None = None,
    applicant_lastname: str | None = None,
    comment: str | None = None,
) -> Document:
    """
    Resolve a document review.

    Args:
        session: Database session
        document_id: Document ID to resolve
        reviewer: User resolving the document
        final_category: Final category after review
        applicant_name: Updated applicant name (optional)
        applicant_lastname: Updated applicant lastname (optional)
        comment: Reviewer notes (optional)

    Returns:
        Updated document

    Raises:
        ValueError: If document not found, not claimed by this reviewer
    """
    # Load document and calculate duration
    result = await session.execute(select(Document).where(Document.id == document_id))
    document = result.scalar_one_or_none()

    if not document:
        msg = f"Документ {document_id} не найден"
        raise ValueError(msg)

    if document.status != DocumentStatus.IN_REVIEW:
        msg = (
            f"Документ {document_id} не находится в обработке (статус: {document.status.value})"
        )
        raise ValueError(msg)

    if document.assigned_reviewer_id != reviewer.id:
        msg = f"Документ {document_id} не закреплён за этим рецензентом"
        raise ValueError(msg)

    # Find the claim action to calculate duration
    claim_result = await session.execute(
        select(ReviewAction)
        .where(
            ReviewAction.document_id == document_id,
            ReviewAction.reviewer_id == reviewer.id,
            ReviewAction.action == ReviewActionType.CLAIM,
        )
        .order_by(ReviewAction.created_at.desc())
        .limit(1)
    )
    claim_action = claim_result.scalar_one_or_none()

    duration_seconds = None
    if claim_action:
        duration = datetime.now(UTC) - claim_action.created_at
        duration_seconds = int(duration.total_seconds())

    # Determine action type
    action_type = (
        ReviewActionType.ACCEPT
        if final_category == document.category_predicted
        else ReviewActionType.OVERRIDE
    )

    # Update document
    document.category_final = final_category
    document.status = DocumentStatus.RESOLVED
    document.updated_at = datetime.now(UTC)

    if applicant_name is not None:
        document.applicant_name = applicant_name
    if applicant_lastname is not None:
        document.applicant_lastname = applicant_lastname

    # Create review action
    action = ReviewAction(
        document_id=document.id,
        reviewer_id=reviewer.id,
        action=action_type,
        from_category=document.category_predicted,
        to_category=final_category,
        comment=comment,
        duration_seconds=duration_seconds,
    )
    session.add(action)

    await session.commit()
    await session.refresh(document)

    logger.info(
        f"Документ {document_id} обработан рецензентом {reviewer.id} "
        f"({reviewer.email}): {document.category_predicted} -> {final_category} "
        f"за {duration_seconds}s"
    )

    return document


async def get_document_audit_trail(
    session: AsyncSession,
    document_id: int,
) -> Sequence[ReviewAction]:
    """
    Get audit trail for a document.

    Args:
        session: Database session
        document_id: Document ID

    Returns:
        List of review actions ordered by creation time
    """
    result = await session.execute(
        select(ReviewAction)
        .options(selectinload(ReviewAction.reviewer))
        .where(ReviewAction.document_id == document_id)
        .order_by(ReviewAction.created_at.asc())
    )
    return result.scalars().all()


async def get_document_by_id(
    session: AsyncSession,
    document_id: int,
) -> Document | None:
    """
    Get a document by ID with related data loaded.

    Args:
        session: Database session
        document_id: Document ID

    Returns:
        Document with text content and assigned reviewer loaded, or None
    """
    result = await session.execute(
        select(Document)
        .options(
            selectinload(Document.text_content),
            selectinload(Document.assigned_reviewer),
        )
        .where(Document.id == document_id)
    )
    return result.scalar_one_or_none()


__all__ = [
    "claim_document",
    "get_document_audit_trail",
    "get_document_by_id",
    "get_review_queue",
    "release_document",
    "resolve_document",
]
