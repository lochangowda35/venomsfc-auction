"""Add isolated Internal Cup domain tables.

Revision ID: c2d4f61a9b70
Revises: e472dff7df2c
Create Date: 2026-11-09
"""

from alembic import op
import sqlalchemy as sa


revision = "c2d4f61a9b70"
down_revision = "e472dff7df2c"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cup_players",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("auction_player_id", sa.Integer()),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("photo_path", sa.String(length=500), nullable=False),
        sa.Column("position", sa.String(length=80), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("auction_player_id"),
    )
    op.create_table(
        "cup_teams",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("auction_team_id", sa.Integer()),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("logo_path", sa.String(length=500), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("auction_team_id"),
    )
    op.create_table(
        "cup_tournaments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("edition", sa.String(length=80), nullable=False),
        sa.Column("lifecycle", sa.String(length=20), nullable=False),
        sa.Column("timezone", sa.String(length=80), nullable=False),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "lifecycle IN ('draft', 'published', 'running', 'completed', 'archived')",
            name="ck_cup_tournaments_lifecycle",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "cup_roster_memberships",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["player_id"], ["cup_players.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["team_id"], ["cup_teams.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["tournament_id"], ["cup_tournaments.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_cup_roster_tournament_active", "cup_roster_memberships",
        ["tournament_id", "active"], unique=False,
    )
    op.create_table(
        "cup_matches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("stage", sa.String(length=20), nullable=False),
        sa.Column("home_team_id", sa.Integer(), nullable=True),
        sa.Column("away_team_id", sa.Integer(), nullable=True),
        sa.Column("match_order", sa.Integer(), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("clock", sa.JSON(), nullable=False),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "stage IN ('league', 'third_place', 'final')", name="ck_cup_matches_stage"
        ),
        sa.CheckConstraint(
            "state IN ('draft', 'scheduled', 'live', 'paused', 'review', 'finalized', 'archived')",
            name="ck_cup_matches_state",
        ),
        sa.ForeignKeyConstraint(["away_team_id"], ["cup_teams.id"]),
        sa.ForeignKeyConstraint(["home_team_id"], ["cup_teams.id"]),
        sa.ForeignKeyConstraint(["tournament_id"], ["cup_tournaments.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tournament_id", "match_order", name="uq_cup_match_order"),
    )
    op.create_index(
        "ix_cup_matches_tournament_state", "cup_matches",
        ["tournament_id", "state"], unique=False,
    )
    op.create_table(
        "cup_participations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("match_id", sa.Integer(), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("goalkeeper", sa.Boolean(), nullable=False),
        sa.Column("entered_minute", sa.Integer(), nullable=True),
        sa.Column("left_minute", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "status IN ('starter', 'bench', 'entered', 'substituted', 'dismissed')",
            name="ck_cup_participation_status",
        ),
        sa.ForeignKeyConstraint(["match_id"], ["cup_matches.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["player_id"], ["cup_players.id"]),
        sa.ForeignKeyConstraint(["team_id"], ["cup_teams.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("match_id", "player_id", name="uq_cup_participation_player"),
    )
    op.create_table(
        "cup_match_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("match_id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.String(length=64), nullable=False),
        sa.Column("event_type", sa.String(length=20), nullable=False),
        sa.Column("minute", sa.Integer(), nullable=False),
        sa.Column("period", sa.String(length=20), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("assist_player_id", sa.Integer(), nullable=True),
        sa.Column("goalkeeper_id", sa.Integer(), nullable=True),
        sa.Column("outcome", sa.String(length=20), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("voided", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "event_type IN ('shot', 'own_goal', 'yellow_card', 'red_card', 'substitution', 'shootout')",
            name="ck_cup_event_type",
        ),
        sa.CheckConstraint("minute >= 0", name="ck_cup_event_minute"),
        sa.ForeignKeyConstraint(["assist_player_id"], ["cup_players.id"]),
        sa.ForeignKeyConstraint(["goalkeeper_id"], ["cup_players.id"]),
        sa.ForeignKeyConstraint(["match_id"], ["cup_matches.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["player_id"], ["cup_players.id"]),
        sa.ForeignKeyConstraint(["team_id"], ["cup_teams.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id"),
    )
    op.create_index(
        "ix_cup_events_match_voided", "cup_match_events", ["match_id", "voided"], unique=False
    )
    op.create_table(
        "cup_audit",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("match_id", sa.Integer(), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("actor_hash", sa.String(length=64), nullable=True),
        sa.Column("expected_version", sa.Integer(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("inverse", sa.JSON(), nullable=False),
        sa.Column("undone_by_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["match_id"], ["cup_matches.id"]),
        sa.ForeignKeyConstraint(["tournament_id"], ["cup_tournaments.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["undone_by_id"], ["cup_audit.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id"),
    )
    op.create_index(
        "ix_cup_audit_tournament_created", "cup_audit",
        ["tournament_id", "created_at"], unique=False,
    )


def downgrade():
    op.drop_index("ix_cup_audit_tournament_created", table_name="cup_audit")
    op.drop_table("cup_audit")
    op.drop_index("ix_cup_events_match_voided", table_name="cup_match_events")
    op.drop_table("cup_match_events")
    op.drop_table("cup_participations")
    op.drop_index("ix_cup_matches_tournament_state", table_name="cup_matches")
    op.drop_table("cup_matches")
    op.drop_index("ix_cup_roster_tournament_active", table_name="cup_roster_memberships")
    op.drop_table("cup_roster_memberships")
    op.drop_table("cup_tournaments")
    op.drop_table("cup_players")
    op.drop_table("cup_teams")
