from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        nullable=False,
    )


class UserRole(str, enum.Enum):
    REVIEWER = "reviewer"
    ADMIN = "admin"


class DocumentStatus(str, enum.Enum):
    UPLOADED = "uploaded"
    QUEUED = "queued"
    IN_REVIEW = "in_review"
    RESOLVED = "resolved"


class ReviewActionType(str, enum.Enum):
    CLAIM = "claim"
    RELEASE = "release"
    ACCEPT = "accept"
    OVERRIDE = "override"
    REJECT = "reject"
    ASSIGN = "assign"


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        sa.String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    email: Mapped[str] = mapped_column(
        sa.String(255), unique=True, nullable=False, index=True
    )
    display_name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        sa.Enum(UserRole, name="user_role"), nullable=False
    )
    password_hash: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(sa.Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))

    assigned_documents: Mapped[list[Document]] = relationship(
        back_populates="assigned_reviewer",
        foreign_keys="Document.assigned_reviewer_id",
    )
    review_actions: Mapped[list[ReviewAction]] = relationship(back_populates="reviewer")


class Document(TimestampMixin, Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(
        sa.String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    original_name: Mapped[str] = mapped_column(sa.String(512), nullable=False)
    stored_filename: Mapped[str | None] = mapped_column(sa.String(512))
    applicant_name: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    applicant_lastname: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    category_predicted: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    category_confidence: Mapped[float] = mapped_column(
        sa.Float, default=0.0, nullable=False
    )
    category_final: Mapped[str | None] = mapped_column(sa.String(64))
    status: Mapped[DocumentStatus] = mapped_column(
        sa.Enum(DocumentStatus, name="document_status"),
        default=DocumentStatus.UPLOADED,
        nullable=False,
    )
    assigned_reviewer_id: Mapped[str | None] = mapped_column(
        sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    review_started_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True)
    )
    resolved_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    size_bytes: Mapped[int | None] = mapped_column(sa.Integer)

    assigned_reviewer: Mapped[User | None] = relationship(
        back_populates="assigned_documents",
        foreign_keys=[assigned_reviewer_id],
    )
    text: Mapped[DocumentText | None] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        uselist=False,
    )
    review_actions: Mapped[list[ReviewAction]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        sa.Index("ix_documents_status", "status"),
        sa.Index("ix_documents_category", "category_predicted"),
    )


class DocumentText(Base):
    __tablename__ = "document_texts"

    document_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    )
    text_excerpt: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )

    document: Mapped[Document] = relationship(back_populates="text")


class ReviewAction(Base):
    __tablename__ = "review_actions"

    id: Mapped[str] = mapped_column(
        sa.String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    document_id: Mapped[str] = mapped_column(
        sa.String(36),
        sa.ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reviewer_id: Mapped[str | None] = mapped_column(
        sa.String(36),
        sa.ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    action: Mapped[ReviewActionType] = mapped_column(
        sa.Enum(ReviewActionType, name="review_action_type"),
        nullable=False,
    )
    from_category: Mapped[str | None] = mapped_column(sa.String(64))
    to_category: Mapped[str | None] = mapped_column(sa.String(64))
    comment: Mapped[str | None] = mapped_column(sa.Text)
    duration_seconds: Mapped[int | None] = mapped_column(sa.Integer)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )

    document: Mapped[Document] = relationship(back_populates="review_actions")
    reviewer: Mapped[User | None] = relationship(back_populates="review_actions")


__all__ = [
    "Document",
    "DocumentStatus",
    "DocumentText",
    "ReviewAction",
    "ReviewActionType",
    "User",
    "UserRole",
]
