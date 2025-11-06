"""init

Revision ID: 7e19e41c2e1f
Revises:
Create Date: 2025-11-04 08:57:29.767821

"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7e19e41c2e1f"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create initial schema for authentication and review workflow."""

    bind = op.get_bind()

    user_role_enum = sa.Enum("reviewer", "admin", name="user_role")
    document_status_enum = sa.Enum(
        "uploaded",
        "queued",
        "in_review",
        "resolved",
        name="document_status",
    )
    review_action_type_enum = sa.Enum(
        "claim",
        "release",
        "accept",
        "override",
        "reject",
        "assign",
        name="review_action_type",
    )

    if bind.dialect.name != "sqlite":
        user_role_enum.create(bind, checkfirst=True)
        document_status_enum.create(bind, checkfirst=True)
        review_action_type_enum.create(bind, checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("role", user_role_enum, nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "documents",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column("original_name", sa.String(length=512), nullable=False),
        sa.Column("stored_filename", sa.String(length=512)),
        sa.Column("applicant_name", sa.String(length=128), nullable=False),
        sa.Column("applicant_lastname", sa.String(length=128), nullable=False),
        sa.Column("category_predicted", sa.String(length=64), nullable=False),
        sa.Column(
            "category_confidence",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0.0"),
        ),
        sa.Column("category_final", sa.String(length=64)),
        sa.Column("status", document_status_enum, nullable=False),
        sa.Column("assigned_reviewer_id", sa.String(length=36), nullable=True),
        sa.Column("review_started_at", sa.DateTime(timezone=True)),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["assigned_reviewer_id"],
            ["users.id"],
            name="fk_documents_assigned_reviewer_id_users",
            ondelete="SET NULL",
        ),
    )
    op.create_index("ix_documents_status", "documents", ["status"], unique=False)
    op.create_index(
        "ix_documents_category", "documents", ["category_predicted"], unique=False
    )

    op.create_table(
        "document_texts",
        sa.Column(
            "document_id", sa.String(length=36), primary_key=True, nullable=False
        ),
        sa.Column("text_excerpt", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name="fk_document_texts_document_id_documents",
            ondelete="CASCADE",
        ),
    )

    op.create_table(
        "review_actions",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("reviewer_id", sa.String(length=36)),
        sa.Column("action", review_action_type_enum, nullable=False),
        sa.Column("from_category", sa.String(length=64)),
        sa.Column("to_category", sa.String(length=64)),
        sa.Column("comment", sa.Text()),
        sa.Column("duration_seconds", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name="fk_review_actions_document_id_documents",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reviewer_id"],
            ["users.id"],
            name="fk_review_actions_reviewer_id_users",
            ondelete="SET NULL",
        ),
    )
    op.create_index(
        "ix_review_actions_document_id",
        "review_actions",
        ["document_id"],
        unique=False,
    )
    op.create_index(
        "ix_review_actions_reviewer_id",
        "review_actions",
        ["reviewer_id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop all schema objects created in the initial migration."""

    bind = op.get_bind()

    op.drop_index("ix_review_actions_reviewer_id", table_name="review_actions")
    op.drop_index("ix_review_actions_document_id", table_name="review_actions")
    op.drop_table("review_actions")

    op.drop_table("document_texts")

    op.drop_index("ix_documents_category", table_name="documents")
    op.drop_index("ix_documents_status", table_name="documents")
    op.drop_table("documents")

    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")

    review_action_type_enum = sa.Enum(
        "claim",
        "release",
        "accept",
        "override",
        "reject",
        "assign",
        name="review_action_type",
    )
    document_status_enum = sa.Enum(
        "uploaded",
        "queued",
        "in_review",
        "resolved",
        name="document_status",
    )
    user_role_enum = sa.Enum("reviewer", "admin", name="user_role")

    if bind.dialect.name != "sqlite":
        review_action_type_enum.drop(bind, checkfirst=True)
        document_status_enum.drop(bind, checkfirst=True)
        user_role_enum.drop(bind, checkfirst=True)
