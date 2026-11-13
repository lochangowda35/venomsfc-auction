"""Loopback-only in-memory Cup fixture for host-desk browser regressions."""

import os
from datetime import datetime, timedelta, timezone

from flask import jsonify, request
from sqlalchemy.pool import StaticPool
from werkzeug.security import generate_password_hash

os.environ.pop("PGDATABASE", None)
os.environ.pop("TRUST_PROXY", None)

from app import create_app
from cup_rules import schedule_fixtures
from extensions import db
from models import CupMatch, CupPlayer, CupRosterMembership, CupTeam, CupTournament


class FixtureClock:
    def __init__(self):
        self.current = datetime.now(timezone.utc)

    def now(self):
        return self.current

    def advance(self, seconds):
        self.current += timedelta(seconds=seconds)
        return self.current


clock = FixtureClock()
completed_league = os.environ.get("CUP_FIXTURE_COMPLETED_LEAGUE") == "1"
app = create_app({
    "TESTING": True,
    "SECRET_KEY": "synthetic-lineup-session",
    "HOST_PASSWORD_HASH": generate_password_hash("synthetic-lineup-password"),
    "SQLALCHEMY_DATABASE_URI": "sqlite://",
    "SQLALCHEMY_ENGINE_OPTIONS": {
        "connect_args": {"check_same_thread": False},
        "poolclass": StaticPool,
    },
    "CUP_TEST_CLOCK": clock.now,
})
with app.app_context():
    db.create_all()
    now = clock.now()
    cup = CupTournament(
        name="Synthetic Cup", edition="Test",
        lifecycle="running" if completed_league else "published", timezone="UTC",
        settings={
            "points_win": 3, "points_draw": 1, "players_per_side": 4,
            "half_minutes": 1, "break_minutes": 2, "between_match_rest_minutes": 15,
            "playoff_rest_minutes": 60, "tie_resolutions": [],
        }, version=0, created_at=now,
    )
    db.session.add(cup)
    for team_id in range(1, 6):
        db.session.add(CupTeam(id=team_id, name=f"Synthetic team {team_id}", logo_path=""))
        for index in range(1, 6):
            player_id = team_id * 100 + index
            db.session.add(CupPlayer(id=player_id, name=f"Team {team_id} player {index}",
                                     position="GK" if index == 1 else "MID",
                                     photo_path="", active=True))
            db.session.add(CupRosterMembership(tournament_id=1, team_id=team_id,
                                               player_id=player_id, active=True, created_at=now))
    fixtures = schedule_fixtures([1, 2, 3, 4, 5], now, 2, 15)
    db.session.add_all([
        CupMatch(
            id=fixture["match_order"], tournament_id=1, stage="league",
            home_team_id=fixture["home_team_id"], away_team_id=fixture["away_team_id"],
            match_order=fixture["match_order"], scheduled_at=fixture["scheduled_at"],
            state="finalized" if completed_league else "scheduled", settings={}, version=0,
            clock={"period": "full_time"} if completed_league else {},
            finalized_at=now if completed_league else None,
        )
        for fixture in fixtures
    ])
    db.session.commit()


@app.get("/__simulation/clock")
def read_fixture_clock():
    return jsonify(now=clock.now().isoformat())


@app.post("/__simulation/clock")
def advance_fixture_clock():
    data = request.get_json(silent=True) or {}
    seconds = data.get("advance_seconds")
    if type(seconds) is not int or seconds < 0 or seconds > 86_400:
        return jsonify(error="advance_seconds must be an integer from 0 to 86400."), 400
    return jsonify(now=clock.advance(seconds).isoformat())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=60574, debug=False, use_reloader=False, threaded=False)
