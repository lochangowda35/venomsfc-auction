"""Start an isolated loopback preview using the approved ignored data copy."""

import argparse
import hashlib
import ipaddress
import json
import os
import secrets
import socket
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

from sqlalchemy import URL
from flask import jsonify, request
from werkzeug.security import generate_password_hash

from app import create_app
from cup_rules import schedule_fixtures
from extensions import db
from models import Auction, CupMatch, CupPlayer, CupRosterMembership, CupTeam, CupTournament, Player, Team


BACKEND_DIR = Path(__file__).resolve().parent
SOURCE_COPY = BACKEND_DIR / "uploads" / "internal-cup-test-copy-20261110-004159"


def _read_approved_copy():
    manifest_path = SOURCE_COPY / "copy-manifest.json"
    data_path = SOURCE_COPY / "cup-test-data.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    data = json.loads(data_path.read_text(encoding="utf-8"))
    if (manifest.get("team_count"), manifest.get("player_count"),
            manifest.get("assigned_count"), manifest.get("unassigned_count"),
            manifest.get("asset_count")) != (5, 28, 26, 2, 33):
        raise RuntimeError("The approved test-copy inventory does not match the reviewed dataset.")

    media_by_source_path = {}
    for asset in manifest["assets"]:
        relative = PurePosixPath(asset["local_path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("The approved test-copy manifest contains an unsafe path.")
        source = (SOURCE_COPY / Path(*relative.parts)).resolve(strict=True)
        source.relative_to(SOURCE_COPY.resolve())
        contents = source.read_bytes()
        if len(contents) != asset["bytes"] or hashlib.sha256(contents).hexdigest() != asset["sha256"]:
            raise RuntimeError(f"Copied media checksum verification failed: {asset['local_path']}")
        media_by_source_path[asset["local_path"]] = contents
    return manifest, data, media_by_source_path


def _make_preview_directory(prefix="internal-cup-preview"):
    uploads = BACKEND_DIR / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    target = uploads / f"{prefix}-{uuid.uuid4().hex[:12]}"
    target.mkdir(exist_ok=False)
    return target


def _free_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class _SimulationClock:
    def __init__(self):
        self._now = datetime(2026, 11, 10, 0, 0, tzinfo=timezone.utc)
        self._lock = threading.Lock()

    def __call__(self):
        with self._lock:
            return self._now

    def advance(self, seconds):
        with self._lock:
            self._now += timedelta(seconds=seconds)
            return self._now


def _seed_preview(app, target, data, source_media, include_cup=True):
    media_folder = target / "media"
    media_folder.mkdir(exist_ok=False)
    media_paths = {}
    for asset_path, contents in source_media.items():
        name = f"{hashlib.sha256(contents).hexdigest()[:32]}.jpg"
        (media_folder / name).write_bytes(contents)
        media_paths[asset_path] = f"/api/media/{name}"

    with app.app_context():
        db.create_all()
        teams = [
            Team(
                id=row["id"], name=row["name"],
                logo_path=media_paths[row["logo_path"]],
            )
            for row in data["teams"]
        ]
        players = [
            Player(
                id=row["id"], name=row["name"], position=row["position"],
                photo_path=media_paths[row["photo_path"]],
            )
            for row in data["players"]
        ]
        db.session.add_all([*teams, *players])
        db.session.flush()

        assignments = {
            str(player_id): {"team_id": team["id"], "price": 0}
            for team in data["teams"]
            for player_id in team["player_ids"]
        }
        db.session.add(Auction(
            id=1,
            version=1,
            state={
                "status": "completed", "squad_size": 5, "current": None,
                "sales": assignments, "unsold": [], "last_event": None,
                "captains": {}, "open_set": None,
            },
        ))

        if not include_cup:
            db.session.commit()
            db.session.remove()
            return

        db.session.add_all([
            CupTeam(id=team.id, auction_team_id=team.id, name=team.name, logo_path=team.logo_path)
            for team in teams
        ] + [
            CupPlayer(id=player.id, auction_player_id=player.id, name=player.name,
                      photo_path=player.photo_path, position=player.position, active=True)
            for player in players
        ])
        db.session.flush()
        now = datetime.now(timezone.utc)
        settings = {
            "points_win": 3, "points_draw": 1, "players_per_side": 5,
            "half_minutes": 10, "break_minutes": 5,
            "between_match_rest_minutes": 15, "playoff_rest_minutes": 60,
            "tie_resolutions": [],
        }
        tournament = CupTournament(
            name="Venoms Internal Cup", edition="Local preview",
            lifecycle="draft", timezone="Asia/Kolkata",
            settings=settings, version=1, created_at=now,
        )
        db.session.add(tournament)
        db.session.flush()
        memberships = [
            CupRosterMembership(
                tournament_id=tournament.id, team_id=team["id"],
                player_id=player_id, active=True, created_at=now,
            )
            for team in data["teams"]
            for player_id in team["player_ids"]
        ]
        db.session.add_all(memberships)

        team_ids = sorted(team["id"] for team in data["teams"])
        first_kickoff = now + timedelta(days=2)
        fixtures = schedule_fixtures(
            team_ids, first_kickoff,
            settings["half_minutes"] * 2 + settings["break_minutes"],
            settings["between_match_rest_minutes"],
        )
        db.session.add_all([
            CupMatch(
                tournament_id=tournament.id, stage="league",
                home_team_id=fixture["home_team_id"],
                away_team_id=fixture["away_team_id"],
                match_order=fixture["match_order"],
                scheduled_at=fixture["scheduled_at"],
                state="draft", settings={}, version=0, clock={},
            )
            for fixture in fixtures
        ])
        db.session.commit()
        db.session.remove()


def _register_simulation_clock(app, clock):
    @app.post("/__simulation/clock")
    def advance_simulation_clock():
        if request.remote_addr is None:
            return jsonify(error="Loopback access only."), 403
        try:
            is_loopback = ipaddress.ip_address(request.remote_addr).is_loopback
        except ValueError:
            is_loopback = False
        if not is_loopback:
            return jsonify(error="Loopback access only."), 403
        body = request.get_json(silent=True)
        seconds = body.get("advance_seconds") if isinstance(body, dict) else None
        if type(seconds) is not int or seconds < 0 or seconds > 31 * 24 * 60 * 60:
            return jsonify(error="advance_seconds must be an integer from 0 to 31 days."), 400
        return jsonify(now=clock.advance(seconds).isoformat())

    @app.get("/__simulation/clock")
    def simulation_clock():
        return jsonify(now=clock().isoformat())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--simulation", action="store_true",
        help="Create a separate empty Cup database with a loopback-only controllable clock.",
    )
    args = parser.parse_args()
    manifest, data, source_media = _read_approved_copy()
    target = _make_preview_directory(
        "internal-cup-simulation" if args.simulation else "internal-cup-preview"
    )
    database_path = target / "preview.sqlite3"
    password_path = target / "host-password.local"
    password = secrets.token_urlsafe(24)
    password_path.write_text(password + "\n", encoding="utf-8")
    try:
        password_path.chmod(0o600)
    except OSError:
        pass

    media_folder = target / "media"
    simulation_clock = _SimulationClock() if args.simulation else None
    config = {
        "SECRET_KEY": secrets.token_hex(32),
        "HOST_PASSWORD_HASH": generate_password_hash(password),
        "SESSION_COOKIE_SECURE": False,
        "SQLALCHEMY_DATABASE_URI": URL.create("sqlite", database=str(database_path)),
        "SQLALCHEMY_ENGINE_OPTIONS": {
            "connect_args": {"check_same_thread": False},
        },
        "UPLOAD_FOLDER": str(media_folder),
        "CUP_UPLOAD_FOLDER": str(target / "cup-media"),
        "BACKUP_FOLDER": str(target / "backups"),
        "ALLOW_MEDIA_RESTORE": False,
        "TRUST_CLOUDFLARE": False,
        "OFFICIAL_TEAMS": True,
        "PREVIEW_DATA_LABEL": (
            "Isolated local simulation · copied profiles and reconstructed test roster; "
            "original auction prices and history were not copied."
            if args.simulation else
            "Isolated local preview · copied profiles and reconstructed test roster; "
            "original auction prices and history were not copied."
        ),
        **({"CUP_TEST_CLOCK": simulation_clock} if simulation_clock else {}),
    }

    # The preview must not even construct a connection from inherited PostgreSQL settings.
    pg_database = os.environ.pop("PGDATABASE", None)
    trust_proxy = os.environ.pop("TRUST_PROXY", None)
    try:
        app = create_app(config)
    finally:
        if pg_database is not None:
            os.environ["PGDATABASE"] = pg_database
        if trust_proxy is not None:
            os.environ["TRUST_PROXY"] = trust_proxy

    if simulation_clock:
        _register_simulation_clock(app, simulation_clock)
    _seed_preview(app, target, data, source_media, include_cup=not args.simulation)
    port = _free_loopback_port()
    print(f"Cup {'simulation' if args.simulation else 'preview'}: http://127.0.0.1:{port}", flush=True)
    print(f"Dataset: approved copied profiles/teams; {len(data['teams'])} teams, "
          f"{len(data['players'])} players, {manifest['assigned_count']} assigned, "
          f"{manifest['unassigned_count']} available; {len(source_media)} checksummed images.",
          flush=True)
    print(f"SQLite: {database_path}", flush=True)
    print(f"Local host password file: {password_path}", flush=True)
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
