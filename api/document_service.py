"""Document persistence helpers for upload workflow."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from models import Document, DocumentStatus, DocumentText

logger = logging.getLogger(__name__)

# Confidence threshold - documents below this go to review queue
CONFIDENCE_THRESHOLD = 0.7


@dataclass
class DocumentMetadata:
    """Metadata for document persistence."""

    original_name: str
    file_path: str
    file_size: int
    mime_type: str
    category: str
    confidence_score: float
    text_excerpt: str | None = None


def compute_confidence_score(
    category: str,
    text: str,
    fuzzy_score: float | None = None,
) -> float:
    """
    Compute confidence score for a classification result.

    For now, this is a simple heuristic based on:
    - Whether fuzzy matching was used (lower confidence)
    - Text length (very short text = lower confidence)
    - Whether category is UNCLASSIFIED (0.0 confidence)

    Returns float between 0.0 and 1.0
    """
    if category in {"Unclassified", "ERROR"}:
        return 0.0

    # Start with base confidence
    confidence = 0.85

    # If fuzzy matching was used with a score, adjust
    if fuzzy_score is not None:
        # fuzzy_score is 0-100, normalize to 0-1
        confidence = min(confidence, fuzzy_score / 100.0)

    # Penalize very short text (likely poor OCR)
    text_len = len(text.strip())
    if text_len < 50:
        confidence *= 0.5
    elif text_len < 150:
        confidence *= 0.75

    return round(confidence, 3)


def determine_review_status(confidence: float) -> DocumentStatus:
    """
    Determine initial review status based on confidence.

    High confidence (>= threshold): uploaded (no review needed)
    Low confidence (< threshold): queued (needs human review)
    """
    if confidence >= CONFIDENCE_THRESHOLD:
        return DocumentStatus.UPLOADED
    return DocumentStatus.QUEUED


async def persist_document(
    session: AsyncSession,
    metadata: DocumentMetadata,
) -> Document:
    """
    Create and persist a new Document record with optional text excerpt.

    Returns the created Document instance.
    """
    status = determine_review_status(metadata.confidence_score)

    doc = Document(
        original_name=metadata.original_name,
        file_path=metadata.file_path,
        file_size=metadata.file_size,
        mime_type=metadata.mime_type,
        category=metadata.category,
        confidence_score=metadata.confidence_score,
        status=status,
    )
    session.add(doc)

    # If we have text, store excerpt for preview
    if metadata.text_excerpt:
        excerpt = DocumentText(
            document_id=doc.id,
            text_excerpt=metadata.text_excerpt[:5000],  # Limit to config max
        )
        session.add(excerpt)

    await session.flush()  # Ensure doc.id is available
    logger.info(
        "Persisted document %s: category=%s confidence=%.2f status=%s",
        doc.id,
        metadata.category,
        metadata.confidence_score,
        status.value,
    )

    return doc


async def update_document_metadata(
    session: AsyncSession,
    document_id: str,
    **kwargs: str | float | datetime,
) -> None:
    """
    Update specific fields on an existing Document.

    kwargs: field names and new values (e.g., status="resolved")
    """
    stmt = (
        sa.update(Document)
        .where(Document.id == document_id)
        .values(**kwargs, updated_at=datetime.now(UTC))
    )
    await session.execute(stmt)
    await session.commit()
    logger.info("Updated document %s: %s", document_id, kwargs)


__all__ = [
    "CONFIDENCE_THRESHOLD",
    "DocumentMetadata",
    "compute_confidence_score",
    "determine_review_status",
    "persist_document",
    "update_document_metadata",
]
