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
# Set to 0.9 to send most documents to review (HITL workflow)
CONFIDENCE_THRESHOLD = 0.9


@dataclass
class DocumentMetadata:
    """Metadata for document persistence."""

    original_name: str
    file_path: str
    file_size: int
    mime_type: str
    category: str
    confidence_score: float
    applicant_name: str
    applicant_lastname: str
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

    # Determine base confidence based on match type
    if fuzzy_score is None:
        # Exact keyword match - high confidence
        confidence = 0.95
    else:
        # Fuzzy match - confidence based on fuzzy score (0-100)
        # Scale fuzzy score from 0-100 to 0.6-0.9 range
        confidence = 0.6 + (fuzzy_score / 100.0) * 0.3

    # Adjust confidence based on text length
    text_len = len(text.strip())
    if text_len < 50:
        # Very short text - likely poor OCR
        confidence *= 0.5
    elif text_len < 150:
        # Short text - somewhat unreliable
        confidence *= 0.75
    elif text_len < 300:
        # Medium text - slightly reduce confidence
        confidence *= 0.9

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
        stored_filename=metadata.file_path,
        applicant_name=metadata.applicant_name,
        applicant_lastname=metadata.applicant_lastname,
        category_predicted=metadata.category,
        category_confidence=metadata.confidence_score,
        status=status,
        size_bytes=metadata.file_size,
    )
    session.add(doc)

    # If we have text, store excerpt for preview
    if metadata.text_excerpt:
        # Attach via relationship so FK populates after primary key assignment
        doc.text = DocumentText(
            text_excerpt=metadata.text_excerpt[:5000],  # Limit to config max
        )

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
