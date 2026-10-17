from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String, JSON
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
