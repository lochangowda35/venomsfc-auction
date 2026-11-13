from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from extensions import db


class Team(db.Model):
    __tablename__ = "teams"
    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="ck_teams_name_not_blank"),
        CheckConstraint(
            "length(trim(logo_path)) > 0", name="ck_teams_logo_path_not_blank"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    logo_path: Mapped[str] = mapped_column(String(500))


class Player(db.Model):
    __tablename__ = "players"
    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="ck_players_name_not_blank"),
        CheckConstraint(
            "length(trim(photo_path)) > 0", name="ck_players_photo_path_not_blank"
        ),
        CheckConstraint(
            "length(trim(position)) > 0", name="ck_players_position_not_blank"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    photo_path: Mapped[str] = mapped_column(String(500))
    position: Mapped[str] = mapped_column(String(80))


class HostSession(db.Model):
    __tablename__ = "host_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class CupHostSession(db.Model):
    __tablename__ = "cup_host_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Auction(db.Model):
    __tablename__ = "auction"

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(default=0)
    state: Mapped[dict] = mapped_column(JSON)


class AuctionEvent(db.Model):
    __tablename__ = "auction_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True)
    payload: Mapped[dict] = mapped_column(JSON)
    action: Mapped[str] = mapped_column(String(30))
    before: Mapped[dict] = mapped_column(JSON)
    after: Mapped[dict] = mapped_column(JSON)
    version: Mapped[int] = mapped_column()
    undone: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CupPlayer(db.Model):
    __tablename__ = "cup_players"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    auction_player_id: Mapped[int | None] = mapped_column(Integer, unique=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    photo_path: Mapped[str] = mapped_column(String(500), nullable=False)
    position: Mapped[str] = mapped_column(String(80), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CupTeam(db.Model):
    __tablename__ = "cup_teams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    auction_team_id: Mapped[int | None] = mapped_column(Integer, unique=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    logo_path: Mapped[str] = mapped_column(String(500), nullable=False)


class CupTournament(db.Model):
    __tablename__ = "cup_tournaments"
    __table_args__ = (
        CheckConstraint(
            "lifecycle IN ('draft', 'published', 'running', 'completed', 'archived')",
            name="ck_cup_tournaments_lifecycle",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    edition: Mapped[str] = mapped_column(String(80), nullable=False)
    lifecycle: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    timezone: Mapped[str] = mapped_column(String(80), nullable=False, default="Asia/Kolkata")
    settings: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CupRosterMembership(db.Model):
    __tablename__ = "cup_roster_memberships"
    __table_args__ = (
        Index("ix_cup_roster_tournament_active", "tournament_id", "active"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(
        ForeignKey("cup_tournaments.id", ondelete="RESTRICT"), nullable=False
    )
    team_id: Mapped[int] = mapped_column(
        ForeignKey("cup_teams.id", ondelete="RESTRICT"), nullable=False
    )
    player_id: Mapped[int] = mapped_column(
        ForeignKey("cup_players.id", ondelete="RESTRICT"), nullable=False
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CupMatch(db.Model):
    __tablename__ = "cup_matches"
    __table_args__ = (
        CheckConstraint(
            "stage IN ('league', 'third_place', 'final')",
            name="ck_cup_matches_stage",
        ),
        CheckConstraint(
            "state IN ('draft', 'scheduled', 'live', 'paused', 'review', 'finalized', 'archived')",
            name="ck_cup_matches_state",
        ),
        UniqueConstraint("tournament_id", "match_order", name="uq_cup_match_order"),
        Index("ix_cup_matches_tournament_state", "tournament_id", "state"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(
        ForeignKey("cup_tournaments.id", ondelete="RESTRICT"), nullable=False
    )
    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    home_team_id: Mapped[int | None] = mapped_column(ForeignKey("cup_teams.id"))
    away_team_id: Mapped[int | None] = mapped_column(ForeignKey("cup_teams.id"))
    match_order: Mapped[int] = mapped_column(Integer, nullable=False)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    settings: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clock: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CupParticipation(db.Model):
    __tablename__ = "cup_participations"
    __table_args__ = (
        UniqueConstraint("match_id", "player_id", name="uq_cup_participation_player"),
        CheckConstraint(
            "status IN ('starter', 'bench', 'entered', 'substituted', 'dismissed')",
            name="ck_cup_participation_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(
        ForeignKey("cup_matches.id", ondelete="RESTRICT"), nullable=False
    )
    team_id: Mapped[int] = mapped_column(ForeignKey("cup_teams.id"), nullable=False)
    player_id: Mapped[int] = mapped_column(ForeignKey("cup_players.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    goalkeeper: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    entered_minute: Mapped[int | None] = mapped_column(Integer)
    left_minute: Mapped[int | None] = mapped_column(Integer)


class CupMatchEvent(db.Model):
    __tablename__ = "cup_match_events"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('shot', 'own_goal', 'yellow_card', 'red_card', 'substitution', 'shootout')",
            name="ck_cup_event_type",
        ),
        CheckConstraint("minute >= 0", name="ck_cup_event_minute"),
        Index("ix_cup_events_match_voided", "match_id", "voided"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(
        ForeignKey("cup_matches.id", ondelete="RESTRICT"), nullable=False
    )
    request_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    minute: Mapped[int] = mapped_column(Integer, nullable=False)
    period: Mapped[str] = mapped_column(String(20), nullable=False)
    team_id: Mapped[int] = mapped_column(ForeignKey("cup_teams.id"), nullable=False)
    player_id: Mapped[int] = mapped_column(ForeignKey("cup_players.id"), nullable=False)
    assist_player_id: Mapped[int | None] = mapped_column(ForeignKey("cup_players.id"))
    goalkeeper_id: Mapped[int | None] = mapped_column(ForeignKey("cup_players.id"))
    outcome: Mapped[str | None] = mapped_column(String(20))
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    voided: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CupAudit(db.Model):
    __tablename__ = "cup_audit"
    __table_args__ = (
        Index("ix_cup_audit_tournament_created", "tournament_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(
        ForeignKey("cup_tournaments.id", ondelete="RESTRICT"), nullable=False
    )
    match_id: Mapped[int | None] = mapped_column(ForeignKey("cup_matches.id"))
    request_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    actor_hash: Mapped[str | None] = mapped_column(String(64))
    expected_version: Mapped[int] = mapped_column(Integer, nullable=False)
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    inverse: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    undone_by_id: Mapped[int | None] = mapped_column(ForeignKey("cup_audit.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
