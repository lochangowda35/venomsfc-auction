from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import func, select
from datetime import datetime, timezone
from copy import deepcopy
import secrets

from auth import check_csrf, host_required
from auction import captain_ids, locked_auction, POSITIONS
from extensions import db
from media import valid_media_path
from models import AuctionEvent, Player, Team


profiles = Blueprint("profiles", __name__, url_prefix="/api")
TEAM_FIELDS = {"name": 120, "logo_path": 500}
PLAYER_FIELDS = {"name": 120, "photo_path": 500, "position": 80}


@profiles.before_request
@host_required
def protect_profiles():
    if request.method in {"POST", "PUT", "DELETE"}:
        error = check_csrf()
        if error:
            return error
        if current_app.config["OFFICIAL_TEAMS"] and request.path.startswith("/api/teams"):
            return jsonify(error="The five official teams are fixed for this auction."), 409


@profiles.after_request
def prevent_caching(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def validate_profile(fields):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, {"body": "Provide a JSON object."}
    errors = {}
    for field in data.keys() - fields.keys():
        errors[field] = "Unknown field."
    cleaned = {}
    for field, limit in fields.items():
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            errors[field] = "A non-empty string is required."
        elif len(value.strip()) > limit:
            errors[field] = f"Must be at most {limit} characters."
        elif any(ord(character) < 32 or ord(character) == 127 for character in value):
            errors[field] = "Control characters are not allowed."
        else:
            cleaned[field] = value.strip()
    if "position" in cleaned and cleaned["position"] not in POSITIONS:
        errors["position"] = "Choose GK, DEF, MID, or ST."
    for field in ("photo_path", "logo_path"):
        if field in cleaned and not valid_media_path(cleaned[field]):
            errors[field] = "Upload an image first and use its returned path."
    return cleaned, errors


def serialize_profile(record, fields):
    return {"id": record.id, **{field: getattr(record, field) for field in fields}}


@profiles.get("/teams")
def list_teams():
    teams = db.session.scalars(select(Team).order_by(Team.id)).all()
    return jsonify(teams=[serialize_profile(team, TEAM_FIELDS) for team in teams])


@profiles.post("/teams")
def create_team():
    data, errors = validate_profile(TEAM_FIELDS)
    if errors:
        return jsonify(error="Invalid team profile.", fields=errors), 400
    record = lock_setup()
    if record is None:
        return jsonify(error="Profiles cannot change after the auction starts."), 409
    if db.session.scalar(select(func.count()).select_from(Team)) >= 5:
        db.session.rollback()
        return jsonify(error="A maximum of five teams can be created."), 409
    team = Team(**data)
    db.session.add(team)
    profile_changed(record, "team", "create")
    db.session.commit()
    return jsonify(team=serialize_profile(team, TEAM_FIELDS)), 201


@profiles.get("/players")
def list_players():
    players = db.session.scalars(select(Player).order_by(Player.id)).all()
    return jsonify(players=[serialize_profile(player, PLAYER_FIELDS) for player in players])


@profiles.post("/players")
def create_player():
    data, errors = validate_profile(PLAYER_FIELDS)
    if errors:
        return jsonify(error="Invalid player profile.", fields=errors), 400
    record = lock_setup()
    if record is None:
        return jsonify(error="Profiles cannot change after the auction starts."), 409
    player = Player(**data)
    db.session.add(player)
    profile_changed(record, "player", "create")
    db.session.commit()
    return jsonify(player=serialize_profile(player, PLAYER_FIELDS)), 201


def lock_setup():
    record = locked_auction()
    if record.state["status"] != "setup":
        db.session.rollback()
        return None
    return record


def profile_changed(record, kind, operation):
    before = deepcopy(record.state)
    state = deepcopy(before)
    state["last_event"] = {"action": "profile", "kind": kind, "operation": operation}
    record.state = state
    record.version += 1
    db.session.add(AuctionEvent(
        request_id=secrets.token_hex(24), payload={}, action="profile", before=before,
        after=deepcopy(state), version=record.version, undone=False,
        created_at=datetime.now(timezone.utc),
    ))


def change_profile(model, fields, record_id, singular):
    if request.method == "PUT":
        data, errors = validate_profile(fields)
        if errors:
            return jsonify(error=f"Invalid {singular} profile.", fields=errors), 400
    record = lock_setup()
    if record is None:
        return jsonify(error="Profiles cannot change after the auction starts."), 409
    profile = db.session.get(model, record_id)
    if profile is None:
        db.session.rollback()
        return jsonify(error="Profile not found."), 404
    if request.method == "DELETE":
        state = record.state
        if (singular == "player" and record_id in captain_ids(state)) or (
            singular == "team" and str(record_id) in state.get("captains", {})
        ):
            db.session.rollback()
            return jsonify(error="Remove this captain assignment before deleting the profile."), 409
        db.session.delete(profile)
        profile_changed(record, singular, "delete")
        db.session.commit()
        return jsonify(deleted=record_id)
    for key, value in data.items():
        setattr(profile, key, value)
    profile_changed(record, singular, "edit")
    db.session.commit()
    return jsonify({singular: serialize_profile(profile, fields)})


@profiles.route("/teams/<int:record_id>", methods=["PUT", "DELETE"])
def change_team(record_id):
    return change_profile(Team, TEAM_FIELDS, record_id, "team")


@profiles.route("/players/<int:record_id>", methods=["PUT", "DELETE"])
def change_player(record_id):
    return change_profile(Player, PLAYER_FIELDS, record_id, "player")
