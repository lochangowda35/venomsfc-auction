"""Add independent tournament host sessions.

Revision ID: 57cc976d1e01
Revises: c2d4f61a9b70
"""
from alembic import op
import sqlalchemy as sa

revision = "57cc976d1e01"
down_revision = "c2d4f61a9b70"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cup_host_sessions",
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("token_hash"),
    )
    op.create_index("ix_cup_host_sessions_expires_at", "cup_host_sessions", ["expires_at"])


def downgrade():
    op.drop_index("ix_cup_host_sessions_expires_at", table_name="cup_host_sessions")
    op.drop_table("cup_host_sessions")
