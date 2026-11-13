from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import threading

from flask import Blueprint, current_app, g, jsonify, request
from sqlalchemy import func, or_, select, text

from cup_auth import check_cup_csrf as check_csrf
from cup_auth import current_cup_host_session as current_host_session
from cup_auth import cup_host_required as host_required
from cup_media import valid_cup_media_path
from cup_rules import (
    PERIODS,
    SHOT_OUTCOMES,
    aggregate_player_statistics,
    compute_standings,
    match_score,
    qualification_scenarios,
    schedule_fixtures,
)
from extensions import db
from media import valid_media_path
from models import (
    Auction,
    CupAudit,
    CupMatch,
    CupMatchEvent,
    CupParticipation,
    CupPlayer as Player,
    CupRosterMembership,
    CupTeam as Team,
    CupTournament,
    Player as AuctionPlayer,
    Team as AuctionTeam,
)


cup_api = Blueprint("cup", __name__, url_prefix="/api/cup")
_request_locks = {}
_request_locks_guard = threading.Lock()


class CupError(Exception):
    def __init__(self, message, status=409):
        self.message = message
        self.status = status


def _now():
    clock = current_app.config.get("CUP_TEST_CLOCK")
    return clock() if callable(clock) else datetime.now(timezone.utc)


def _as_utc(value):
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _elapsed_seconds(clock, now):
    elapsed = clock.get("elapsed_seconds", 0)
    anchor = clock.get("anchor")
    if anchor:
        elapsed += max(0, int((now - _as_utc(datetime.fromisoformat(anchor))).total_seconds()))
    return elapsed


def _match_minute(match, tournament, now):
    """Cumulative playing minute from the server clock; breaks and paused time never count."""
    clock = match.clock or {}
    period = clock.get("period")
    half = int(tournament.settings.get("half_minutes", 0))
    extra = int((match.settings or {}).get("extra_time_minutes", 0) or 0)
    fallback_offsets = {
        "first_half": 0,
        "second_half": half,
        "extra_time_1": half * 2,
        "extra_time_2": half * 2 + extra,
    }
    if period not in fallback_offsets:
        raise CupError("Events can only be timed while a playing period is on the clock. Start the next period first.")
    played = clock.get("played_seconds")
    before = played if type(played) is int and played >= 0 else fallback_offsets[period] * 60
    return min(300, (before + _elapsed_seconds(clock, now)) // 60 + 1)


def _error(error):
    return jsonify(error=error.message), error.status


def _body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise CupError("Provide a JSON object.", 400)
    return data


def _request_id(data):
    value = data.get("request_id")
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,64}", value):
        raise CupError("request_id must contain 8 to 64 safe characters.", 400)
    return value


def _expected_version(data, field="expected_version"):
    value = data.get(field)
    if type(value) is not int or value < 0:
        raise CupError(f"{field} must be a non-negative integer.", 400)
    return value


def _request_identity(action, data):
    payload = {key: value for key, value in data.items() if key != "request_id"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {
        "action": action,
        "resource": request.path,
        "payload_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def _lock_request_id(request_id):
    if db.session.get_bind().dialect.name == "postgresql":
        db.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:request_id))"),
            {"request_id": request_id},
        )


def _existing_request(request_id, action, data):
    previous = db.session.scalar(select(CupAudit).where(CupAudit.request_id == request_id))
    if previous is None:
        return None
    if (
        previous.action != action
        or previous.details.get("request_identity") != _request_identity(action, data)
    ):
        raise CupError("request_id was already used for a different action, resource or payload.", 409)
    return previous.details.get("response", {})


def _tournament(tournament_id, lock=False, include_archived=False):
    query = select(CupTournament).where(CupTournament.id == tournament_id)
    if lock:
        query = query.with_for_update()
    tournament = db.session.scalar(query)
    if tournament is None or (tournament.lifecycle == "archived" and not include_archived):
        raise CupError("Tournament not found.", 404)
    return tournament


def _match(match_id, tournament_id=None, lock=False):
    query = select(CupMatch).where(CupMatch.id == match_id)
    if tournament_id is not None:
        query = query.where(CupMatch.tournament_id == tournament_id)
    if lock:
        query = query.with_for_update()
    match = db.session.scalar(query)
    if match is None or match.state == "archived":
        raise CupError("Match not found.", 404)
    return match


def _locked_match_and_tournament(match_id):
    preview = _match(match_id)
    tournament = _tournament(preview.tournament_id, lock=True)
    match = _match(match_id, tournament_id=tournament.id, lock=True)
    if _tournament_paused(tournament):
        raise CupError("The tournament is paused. Resume the tournament before changing a match.")
    return match, tournament


def _tournament_paused(tournament):
    return tournament.lifecycle == "running" and tournament.settings.get("tournament_paused") is True


def _lock_cup_identities():
    if db.session.get_bind().dialect.name == "postgresql":
        db.session.execute(text("SELECT pg_advisory_xact_lock(hashtext('venoms-cup-identities'))"))


def _check_profile_undo_is_isolated(tournament_id, rows):
    for row in rows:
        snapshot = row.inverse
        if snapshot.get("type") != "cup_profile":
            continue
        column = CupRosterMembership.player_id if snapshot["entity"] == "player" else CupRosterMembership.team_id
        foreign_use = db.session.scalar(select(CupRosterMembership.id).where(
            CupRosterMembership.tournament_id != tournament_id,
            column == snapshot["id"],
        ).limit(1))
        if foreign_use is not None:
            raise CupError("This profile is also used by another tournament; undo would change its history.", 409)


def _validate_kickoff(tournament, match):
    if tournament.lifecycle != "running":
        raise CupError("Start the tournament before kicking off a match.")
    if match.stage != "league" and match.settings.get("draw_method") not in {
        "direct_penalties", "extra_time_penalties"
    }:
        raise CupError("Set the playoff draw-deciding method before kickoff.")

    active_match = db.session.scalar(select(CupMatch.id).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.id != match.id,
        CupMatch.state.in_(["live", "paused", "review"]),
    ).limit(1))
    if active_match is not None:
        raise CupError("The single pitch is occupied by another active or under-review match.")

    if not match.home_team_id or not match.away_team_id or match.home_team_id == match.away_team_id:
        raise CupError("Both participating teams must be set and different before kickoff.")

    if match.stage != "league":
        league = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament.id, CupMatch.stage == "league",
            CupMatch.state != "archived",
        )).all()
        if len(league) != 10 or any(row.state != "finalized" for row in league):
            raise CupError("Finalize all ten league matches before starting a playoff.")
        detail = _tournament_dict(tournament)
        if detail["unresolved_tie"]:
            raise CupError("Resolve every exact league-table tie before starting a playoff.")
        standings = detail["standings"]
        positions = (0, 1) if match.stage == "final" else (2, 3)
        if (len(standings) != 5 or match.home_team_id == match.away_team_id
                or {match.home_team_id, match.away_team_id}
                != {standings[index]["id"] for index in positions}):
            raise CupError("The playoff teams must match the qualified league standings.")

    active_roster = {
        (row.player_id, row.team_id)
        for row in db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament.id,
            CupRosterMembership.active.is_(True),
        )).all()
    }
    participations = db.session.scalars(select(CupParticipation).where(
        CupParticipation.match_id == match.id,
    )).all()
    for team_id in (match.home_team_id, match.away_team_id):
        if team_id is None:
            raise CupError("Both participating teams must be set before kickoff.")
        starters = [
            row for row in participations
            if row.team_id == team_id and row.status == "starter"
        ]
        if len(starters) != tournament.settings["players_per_side"]:
            raise CupError("Set the configured number of starting players for both teams before kickoff.")
        if sum(row.goalkeeper for row in starters) != 1:
            raise CupError("Each team must have exactly one active starting goalkeeper.")
        if any((row.player_id, row.team_id) not in active_roster for row in starters):
            raise CupError("Every starter must belong to that team's active cup roster.")


@cup_api.before_request
def serialize_request_id():
    request_id = request.args.get("request_id") if request.method == "GET" else None
    if request.method == "GET":
        match = re.fullmatch(r"/api/cup/host/requests/([A-Za-z0-9._:-]{8,64})", request.path)
        if match:
            request_id = match.group(1)
    if request.method == "POST":
        body = request.get_json(silent=True)
        if isinstance(body, dict):
            request_id = body.get("request_id")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,64}", request_id):
        return None
    with _request_locks_guard:
        entry = _request_locks.setdefault(request_id, {"lock": threading.Lock(), "users": 0})
        entry["users"] += 1
    entry["lock"].acquire()
    g.cup_request_lock_id = request_id
    g.cup_request_lock = entry["lock"]
    return None


@cup_api.after_request
def release_request_id(response):
    request_id = g.pop("cup_request_lock_id", None)
    lock = g.pop("cup_request_lock", None)
    if request_id is not None and lock is not None:
        lock.release()
        with _request_locks_guard:
            entry = _request_locks.get(request_id)
            if entry is not None:
                entry["users"] -= 1
                if entry["users"] == 0:
                    del _request_locks[request_id]
    return response


def _require_csrf():
    response = check_csrf()
    if response is not None:
        return response


def _require_version(tournament, expected):
    if tournament.version != expected:
        raise CupError(
            "This tournament changed in another tab. Refresh and review the current state.",
            409,
        )
    if _tournament_paused(tournament) and request.endpoint not in {
        "cup.control_tournament", "cup.undo_last_action", "cup.archive_tournament",
    }:
        raise CupError("The tournament is paused. Resume it before changing tournament or match data.")


def _record(tournament, request_id, action, expected, inverse, after, details=None, match_id=None):
    tournament.version += 1
    response = {"tournament_id": tournament.id, "version": tournament.version}
    actor = current_host_session()
    audit = CupAudit(
        tournament_id=tournament.id,
        match_id=match_id,
        request_id=request_id,
        action=action,
        actor_hash=actor.token_hash if actor else None,
        expected_version=expected,
        details={
            **(details or {}),
            "after": after,
            "response": response,
            "request_identity": _request_identity(action, request.get_json()),
        },
        inverse=inverse,
        created_at=_now(),
    )
    db.session.add(audit)
    return response


def _audit_rows(tournament_id):
    return db.session.scalars(
        select(CupAudit)
        .where(
            CupAudit.tournament_id == tournament_id,
            CupAudit.action != "request_cancelled",
        )
        .order_by(CupAudit.id)
    ).all()


def _lineup_snapshot(match_id):
    return [
        _participation_snapshot(row)
        for row in db.session.scalars(
            select(CupParticipation).where(CupParticipation.match_id == match_id)
        ).all()
    ]


def _participation_snapshot(row):
    return {
        "player_id": row.player_id,
        "team_id": row.team_id,
        "status": row.status,
        "goalkeeper": row.goalkeeper,
        "entered_minute": row.entered_minute,
        "left_minute": row.left_minute,
    }


def _apply_snapshot(data):
    kind = data["type"]
    if kind == "tournament_control":
        tournament = db.session.get(CupTournament, data["tournament_id"])
        tournament.lifecycle = data["lifecycle"]
        tournament.settings = {**tournament.settings, "tournament_paused": data["paused"]}
        for saved in data["matches"]:
            _apply_snapshot(saved)
    elif kind == "lifecycle":
        tournament = db.session.get(CupTournament, data["tournament_id"])
        tournament.lifecycle = data["value"]
    elif kind == "tournament_match_states":
        tournament = db.session.get(CupTournament, data["tournament_id"])
        tournament.lifecycle = data["lifecycle"]
        for match_id, state in data["matches"]:
            match = db.session.get(CupMatch, match_id)
            if match is not None:
                match.state = state
                match.version += 1
    elif kind == "settings":
        tournament = db.session.get(CupTournament, data["tournament_id"])
        tournament.settings = deepcopy(data["value"])
    elif kind == "memberships":
        for membership_id in data["ids"]:
            membership = db.session.get(CupRosterMembership, membership_id)
            if membership is not None:
                membership.active = data["active"]
                membership.ended_at = None if data["active"] else _now()
        for saved in data.get("restore", []):
            membership = db.session.get(CupRosterMembership, saved["id"])
            if membership is not None:
                membership.active = True
                membership.ended_at = None
    elif kind == "membership_states":
        for saved in data["states"]:
            membership = db.session.get(CupRosterMembership, saved["id"])
            if membership is not None:
                membership.active = saved["active"]
                membership.ended_at = None if saved["active"] else _now()
    elif kind == "cup_profile":
        model = Player if data["entity"] == "player" else Team
        profile = db.session.get(model, data["id"])
        if profile is None:
            raise CupError("Tournament profile no longer exists.")
        for field, value in data["values"].items():
            setattr(profile, field, value)
    elif kind == "event_correction":
        event = db.session.get(CupMatchEvent, data["event_id"])
        if event is None:
            raise CupError("The corrected event no longer exists.")
        for field, value in data["values"].items():
            setattr(event, field, value)
        for saved in data.get("participation", []):
            participant = db.session.scalar(select(CupParticipation).where(
                CupParticipation.match_id == event.match_id,
                CupParticipation.player_id == saved["player_id"],
            ))
            if participant is not None:
                for field in ("status", "goalkeeper", "entered_minute", "left_minute"):
                    setattr(participant, field, saved[field])
        if "tie_resolutions" in data:
            tournament = db.session.get(CupTournament, data["tournament_id"])
            tournament.settings = {**tournament.settings, "tie_resolutions": data["tie_resolutions"]}
        match = db.session.get(CupMatch, event.match_id)
        match.version += 1
    elif kind == "matches":
        for match_id in data["ids"]:
            match = db.session.get(CupMatch, match_id)
            if match is not None:
                match.state = data["state"]
    elif kind == "fixture_schedule":
        saved_rows = [
            db.session.get(CupMatch, saved["id"])
            for saved in data["rows"]
        ]
        for match in saved_rows:
            if match is not None:
                match.match_order = -match.id
        db.session.flush()
        for saved in data["rows"]:
            match = db.session.get(CupMatch, saved["id"])
            if match is not None:
                match.match_order = saved["match_order"]
                scheduled_at = saved["scheduled_at"]
                match.scheduled_at = (
                    _as_utc(datetime.fromisoformat(scheduled_at)) if scheduled_at else None
                )
                match.version += 1
    elif kind == "match_state":
        match = db.session.get(CupMatch, data["match_id"])
        match.state = data["state"]
        finalized_at = data.get("finalized_at")
        match.finalized_at = _as_utc(datetime.fromisoformat(finalized_at)) if finalized_at else None
        match.version += 1
    elif kind == "match_settings":
        match = db.session.get(CupMatch, data["match_id"])
        match.settings = deepcopy(data["settings"])
        match.version += 1
    elif kind == "match_finalization":
        match = db.session.get(CupMatch, data["match_id"])
        match.state = data["state"]
        finalized_at = data.get("finalized_at")
        match.finalized_at = _as_utc(datetime.fromisoformat(finalized_at)) if finalized_at else None
        match.version += 1
        tournament = db.session.get(CupTournament, data["tournament_id"])
        tournament.lifecycle = data["lifecycle"]
    elif kind == "lineup":
        match_id = data["match_id"]
        match = db.session.get(CupMatch, match_id)
        match.version += 1
        existing = {
            row.player_id: row
            for row in db.session.scalars(
                select(CupParticipation).where(CupParticipation.match_id == match_id)
            ).all()
        }
        target_ids = {row["player_id"] for row in data["rows"]}
        for player_id, row in existing.items():
            if player_id not in target_ids:
                db.session.delete(row)
        for saved in data["rows"]:
            row = existing.get(saved["player_id"])
            if row is None:
                row = CupParticipation(match_id=match_id, player_id=saved["player_id"])
                db.session.add(row)
            row.team_id = saved["team_id"]
            row.status = saved["status"]
            row.goalkeeper = saved["goalkeeper"]
            row.entered_minute = saved["entered_minute"]
            row.left_minute = saved["left_minute"]
    elif kind == "event":
        event = db.session.get(CupMatchEvent, data["event_id"])
        if event is not None:
            event.voided = data["voided"]
            db.session.get(CupMatch, event.match_id).version += 1
        for saved in data.get("participation", []):
            row = db.session.scalar(select(CupParticipation).where(
                CupParticipation.match_id == saved["match_id"],
                CupParticipation.player_id == saved["player_id"],
            ))
            if row is not None:
                row.status = saved["status"]
                row.entered_minute = saved["entered_minute"]
                row.left_minute = saved["left_minute"]
                row.goalkeeper = saved["goalkeeper"]
        if "tie_resolutions" in data:
            tournament = db.session.get(CupTournament, data["tournament_id"])
            tournament.settings = {**tournament.settings, "tie_resolutions": data["tie_resolutions"]}
    elif kind == "clock":
        match = db.session.get(CupMatch, data["match_id"])
        match.state = data["state"]
        clock = deepcopy(data["clock"])
        if match.state == "live" and clock.get("anchor"):
            clock["anchor"] = _now().isoformat()
        if "break_elapsed_seconds" in clock and not _tournament_paused(
            db.session.get(CupTournament, match.tournament_id)
        ):
            clock["break_started_at"] = (
                _now() - timedelta(seconds=clock.pop("break_elapsed_seconds"))
            ).isoformat()
        match.clock = clock
        if "settings" in data:
            match.settings = deepcopy(data["settings"])
        match.version += 1
    elif kind == "targets":
        target_ids = data["ids"]
        rows = {row.id: row for row in _audit_rows(data["tournament_id"])}
        targets = [rows[target_id] for target_id in target_ids if target_id in rows]
        if data["redo"]:
            for target in sorted(targets, key=lambda row: row.id):
                _apply_snapshot(target.details["after"])
                target.undone_by_id = None
        else:
            for target in sorted(targets, key=lambda row: row.id, reverse=True):
                _apply_snapshot(target.inverse)
    else:
        raise CupError("This host action has no supported reversal.", 409)


@cup_api.errorhandler(CupError)
def handle_cup_error(error):
    db.session.rollback()
    return _error(error)


@cup_api.after_request
def no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _public_player(player):
    return {
        "id": player.id,
        "name": player.name,
        "photo_path": player.photo_path,
        "position": player.position,
    }


def _shootout_result(match, events):
    attempts = [event for event in events if event.event_type == "shootout"]
    home_count = sum(event.team_id == match.home_team_id for event in attempts)
    away_count = sum(event.team_id == match.away_team_id for event in attempts)
    home_score = sum(
        event.team_id == match.home_team_id and event.payload.get("scored") is True
        for event in attempts
    )
    away_score = sum(
        event.team_id == match.away_team_id and event.payload.get("scored") is True
        for event in attempts
    )
    finished = match.settings.get("shootout_finish")
    if finished:
        return finished["winner_team_id"], home_count, away_count, home_score, away_score
    kicks = match.settings.get("shootout_kicks", 5)
    if min(home_count, away_count) < kicks:
        if home_score - away_score > kicks - away_count:
            return match.home_team_id, home_count, away_count, home_score, away_score
        if away_score - home_score > kicks - home_count:
            return match.away_team_id, home_count, away_count, home_score, away_score
    elif home_count == away_count and home_score != away_score:
        return (
            match.home_team_id if home_score > away_score else match.away_team_id,
            home_count, away_count, home_score, away_score,
        )
    return None, home_count, away_count, home_score, away_score


def _penalty_eligible(match):
    dismissed = select(CupParticipation.player_id).where(
        CupParticipation.match_id == match.id, CupParticipation.status == "dismissed",
    )
    members = db.session.execute(
        select(CupRosterMembership.team_id, CupRosterMembership.player_id)
        .join(Player, Player.id == CupRosterMembership.player_id)
        .where(
            CupRosterMembership.tournament_id == match.tournament_id,
            CupRosterMembership.active.is_(True), Player.active.is_(True),
            CupRosterMembership.team_id.in_([match.home_team_id, match.away_team_id]),
            CupRosterMembership.player_id.not_in(dismissed),
        ).order_by(CupRosterMembership.player_id)
    ).all()
    return {
        team_id: [player_id for side_id, player_id in members if side_id == team_id]
        for team_id in (match.home_team_id, match.away_team_id)
    }


def _penalty_rotation_used(attempts, eligible_ids):
    eligible = set(eligible_ids)
    used = set()
    for event in attempts:
        if event.player_id in eligible:
            used.add(event.player_id)
        if used == eligible:
            used.clear()
    return used


def _public_team(team):
    return {"id": team.id, "name": team.name, "logo_path": team.logo_path}


def _auction_captain_ids(teams, players, memberships):
    auction = db.session.get(Auction, 1)
    captains = auction.state.get("captains", {}) if auction else {}
    return {
        row.team_id: row.player_id
        for row in memberships
        if row.team_id in teams and row.player_id in players
        and teams[row.team_id].auction_team_id is not None
        and players[row.player_id].auction_player_id is not None
        and captains.get(str(teams[row.team_id].auction_team_id), {}).get("player_id")
        == players[row.player_id].auction_player_id
    }


def _events_for_match(match_id):
    return db.session.scalars(
        select(CupMatchEvent)
        .where(CupMatchEvent.match_id == match_id, CupMatchEvent.voided.is_(False))
        .order_by(CupMatchEvent.minute, CupMatchEvent.id)
    ).all()


def _event_dict(event):
    return {
        "id": event.id,
        "event_type": event.event_type,
        "minute": event.minute,
        "period": event.period,
        "team_id": event.team_id,
        "player_id": event.player_id,
        "assist_player_id": event.assist_player_id,
        "goalkeeper_id": event.goalkeeper_id,
        "outcome": event.outcome,
        "payload": event.payload,
        "voided": event.voided,
    }


def _match_dict(match, teams=None, include_events=True, *, events=None, players=None,
                participations=None):
    teams = teams or {
        team.id: team for team in db.session.scalars(select(Team)).all()
    }
    if events is None:
        events = _events_for_match(match.id)
    score = match_score([_event_dict(event) for event in events], match.home_team_id, match.away_team_id) \
        if match.home_team_id is not None and match.away_team_id is not None else {}
    output = {
        "id": match.id,
        "tournament_id": match.tournament_id,
        "stage": match.stage,
        "home_team": _public_team(teams[match.home_team_id]) if match.home_team_id in teams else None,
        "away_team": _public_team(teams[match.away_team_id]) if match.away_team_id in teams else None,
        "home_team_id": match.home_team_id,
        "away_team_id": match.away_team_id,
        "match_order": match.match_order,
        "scheduled_at": _as_utc(match.scheduled_at).isoformat() if match.scheduled_at else None,
        "state": match.state,
        "version": match.version,
        "settings": match.settings,
        "clock": match.clock,
        "home_goals": score.get(match.home_team_id, 0),
        "away_goals": score.get(match.away_team_id, 0),
        "shootout": {
            "home": sum(
                1 for event in events
                if event.event_type == "shootout" and event.team_id == match.home_team_id
                and event.payload.get("scored") is True
            ),
            "away": sum(
                1 for event in events
                if event.event_type == "shootout" and event.team_id == match.away_team_id
                and event.payload.get("scored") is True
            ),
        },
        "finalized_at": _as_utc(match.finalized_at).isoformat() if match.finalized_at else None,
        "shootout_winner_team_id": _shootout_result(match, events)[0],
        "shootout_finish": match.settings.get("shootout_finish"),
    }
    if include_events:
        output["penalty_eligible_player_ids"] = _penalty_eligible(match) \
            if match.clock.get("period") == "shootout" else {}
        if players is None:
            players = {
                player.id: player
                for player in db.session.scalars(select(Player)).all()
            }
        output["events"] = [
            {
                **_event_dict(event),
                "player": _public_player(players[event.player_id]) if event.player_id in players else None,
                "assist": _public_player(players[event.assist_player_id])
                if event.assist_player_id in players else None,
                "goalkeeper": _public_player(players[event.goalkeeper_id])
                if event.goalkeeper_id in players else None,
            }
            for event in events
        ]
        if participations is None:
            participations = db.session.scalars(
                select(CupParticipation).where(CupParticipation.match_id == match.id)
            ).all()
        output["participations"] = [
            {
                "player": _public_player(players[row.player_id]) if row.player_id in players else None,
                "team_id": row.team_id,
                "status": row.status,
                "goalkeeper": row.goalkeeper,
            }
            for row in participations
        ]
    return output


def _tournament_dict(tournament, include_matches=True):
    all_memberships = db.session.scalars(
        select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament.id,
        )
    ).all()
    memberships = [row for row in all_memberships if row.active]
    match_rows = db.session.scalars(
        select(CupMatch).where(
            CupMatch.tournament_id == tournament.id,
            CupMatch.state != "archived",
        ).order_by(CupMatch.match_order)
    ).all()
    match_ids = [match.id for match in match_rows]
    events_by_match = {match_id: [] for match_id in match_ids}
    for event in db.session.scalars(
        select(CupMatchEvent).where(
            CupMatchEvent.match_id.in_(match_ids), CupMatchEvent.voided.is_(False),
        ).order_by(CupMatchEvent.minute, CupMatchEvent.id)
    ).all() if match_ids else []:
        events_by_match[event.match_id].append(event)
    participations_by_match = {match_id: [] for match_id in match_ids}
    for participant in db.session.scalars(
        select(CupParticipation).where(CupParticipation.match_id.in_(match_ids))
    ).all() if match_ids else []:
        participations_by_match[participant.match_id].append(participant)
    team_ids = sorted(
        {row.team_id for row in all_memberships}
        | {team_id for row in match_rows for team_id in (row.home_team_id, row.away_team_id) if team_id is not None}
    )
    teams = {
        team.id: team for team in db.session.scalars(
            select(Team).where(Team.id.in_(team_ids)).order_by(Team.id)
        ).all()
    } if team_ids else {}
    players = {
        player.id: player for player in db.session.scalars(
            select(Player).where(Player.id.in_({row.player_id for row in memberships}))
        ).all()
    } if memberships else {}
    rosters = {
        team_id: [] for team_id in team_ids
    }
    for membership in memberships:
        player = players.get(membership.player_id)
        if player and membership.team_id in rosters:
            rosters[membership.team_id].append(_public_player(player))
    captain_ids = _auction_captain_ids(teams, players, memberships)
    team_rows = [
        {**_public_team(teams[team_id]), "captain_player_id": captain_ids.get(team_id),
         "players": sorted(rosters[team_id], key=lambda p: p["name"].casefold())}
        for team_id in team_ids if team_id in teams
    ]
    match_players = {
        player.id: player for player in db.session.scalars(select(Player)).all()
    } if include_matches and match_rows else {}
    matches = [
        _match_dict(
            match, teams, events=events_by_match[match.id], players=match_players,
            participations=participations_by_match[match.id],
        ) for match in match_rows
    ] if include_matches else []
    tie_resolutions = tournament.settings.get("tie_resolutions", [])
    try:
        standings = compute_standings(team_rows, matches, tie_resolutions)
        unresolved_tie = None
    except ValueError:
        standings = compute_standings(team_rows, matches, [], allow_unresolved=True)
        unresolved_tie = "Host ranking decision required"

    all_events = [
        _event_dict(event) for match in match_rows for event in events_by_match[match.id]
    ]
    stats = aggregate_player_statistics(all_events)
    membership_team = {row.player_id: row.team_id for row in memberships}
    appearance_counts = {}
    for match in match_rows:
        if match.state not in {"live", "paused", "review", "finalized"}:
            continue
        for row in participations_by_match[match.id]:
            if row.status in {"starter", "entered", "substituted", "dismissed"}:
                appearance_counts.setdefault(row.player_id, set()).add(row.match_id)
    stat_player_ids = {row["player_id"] for row in stats} | set(appearance_counts)
    stat_players = match_players
    if not include_matches:
        stat_players = {
            player.id: player for player in db.session.scalars(
                select(Player).where(Player.id.in_(stat_player_ids))
            ).all()
        } if stat_player_ids else {}
    stats_by_player = {row["player_id"]: row for row in stats}
    for player_id, appearances in appearance_counts.items():
        stats_by_player.setdefault(player_id, {"player_id": player_id})["appearances"] = len(appearances)
    leaderboards = {}
    for key in ("goals", "assists", "saves", "shots", "shots_on_target",
                "own_goals", "yellow_cards", "red_cards", "second_yellow_reds", "appearances"):
        ranking = [
            row for row in sorted(stats_by_player.values(), key=lambda row: (-row.get(key, 0), row["player_id"]))
            if row.get(key, 0) > 0
        ]
        current_rank = 0
        previous_value = None
        rows = []
        for index, stat in enumerate(ranking):
            player = stat_players.get(stat["player_id"])
            if player is None:
                continue
            if stat[key] != previous_value:
                current_rank = index + 1
                previous_value = stat[key]
            row = {
                "rank": current_rank,
                "player": _public_player(player),
                "team": _public_team(teams[membership_team[player.id]])
                if membership_team.get(player.id) in teams else None,
                "total": stat[key],
                "appearances": len(appearance_counts.get(player.id, set())),
            }
            rows.append(row)
        leaderboards[key] = rows
    latest_audit = db.session.scalar(
        select(func.max(CupAudit.created_at)).where(CupAudit.tournament_id == tournament.id)
    )
    return {
        "id": tournament.id,
        "name": tournament.name,
        "edition": tournament.edition,
        "lifecycle": "paused" if _tournament_paused(tournament) else tournament.lifecycle,
        "timezone": tournament.timezone,
        "settings": tournament.settings,
        "version": tournament.version,
        "teams": team_rows,
        "standings": standings,
        "unresolved_tie": unresolved_tie,
        "qualification": qualification_scenarios(standings, matches) if include_matches else None,
        "leaderboards": leaderboards,
        "matches": matches,
        "updated_at": max(
            [_as_utc(value) for value in (latest_audit, *(
                match.finalized_at for match in match_rows if match.finalized_at
            )) if value is not None] or [_as_utc(tournament.created_at)]
        ).isoformat(),
    }


@cup_api.get("")
def list_tournaments():
    rows = db.session.scalars(
        select(CupTournament).where(CupTournament.lifecycle != "archived").order_by(CupTournament.id.desc())
    ).all()
    if request.args.get("summary") == "1":
        return jsonify(tournaments=[{
            "id": row.id, "name": row.name, "edition": row.edition,
            "lifecycle": "paused" if _tournament_paused(row) else row.lifecycle,
            "version": row.version,
        } for row in rows])
    return jsonify(tournaments=[_tournament_dict(row, include_matches=False) for row in rows])


@cup_api.get("/<int:tournament_id>")
def public_tournament(tournament_id):
    return jsonify(tournament=_tournament_dict(_tournament(tournament_id)))


@cup_api.get("/matches/<int:match_id>")
def public_match(match_id):
    match = _match(match_id)
    _tournament(match.tournament_id)
    return jsonify(match=_match_dict(match))


@cup_api.get("/players")
def public_players():
    players = db.session.scalars(select(Player).where(Player.active.is_(True)).order_by(Player.name, Player.id)).all()
    memberships = db.session.scalars(
        select(CupRosterMembership).join(CupTournament).where(
            CupRosterMembership.active.is_(True), CupTournament.lifecycle != "archived",
        )
    ).all()
    teams = {team.id: team for team in db.session.scalars(select(Team)).all()}
    return jsonify(players=[
        {
            **_public_player(player),
            "teams": [
                _public_team(teams[row.team_id])
                for row in memberships
                if row.player_id == player.id and row.team_id in teams
            ],
        }
        for player in players
    ])


@cup_api.get("/players/<int:player_id>")
def public_player(player_id):
    player = db.session.get(Player, player_id)
    if player is None or not player.active:
        raise CupError("Player not found.", 404)
    memberships = db.session.scalars(
        select(CupRosterMembership).join(CupTournament).where(
            CupRosterMembership.player_id == player_id,
            CupRosterMembership.active.is_(True),
            CupTournament.lifecycle != "archived",
        )
    ).all()
    team_map = {team.id: team for team in db.session.scalars(select(Team)).all()}
    events = db.session.scalars(
        select(CupMatchEvent).join(CupMatch).join(CupTournament).where(
            CupTournament.lifecycle != "archived",
            or_(
                CupMatchEvent.player_id == player_id,
                CupMatchEvent.assist_player_id == player_id,
                CupMatchEvent.goalkeeper_id == player_id,
            )
        )
    ).all()
    stats = aggregate_player_statistics([_event_dict(event) for event in events])
    stat = next(
        (row for row in stats if row["player_id"] == player_id),
        {"goals": 0, "assists": 0, "shots": 0, "shots_on_target": 0,
         "saves": 0, "own_goals": 0, "yellow_cards": 0, "red_cards": 0,
         "second_yellow_reds": 0},
    )
    participations = db.session.scalars(
        select(CupParticipation).join(CupMatch).join(CupTournament).where(
            CupParticipation.player_id == player_id,
            CupParticipation.status.in_(["starter", "entered", "substituted", "dismissed"]),
            CupMatch.state.in_(["live", "paused", "review", "finalized"]),
            CupTournament.lifecycle != "archived",
        )
    ).all()
    appearances = {
        row.match_id for row in participations
    }
    match_ids = {row.match_id for row in participations}
    history = db.session.scalars(
        select(CupMatch).where(CupMatch.id.in_(match_ids)).order_by(CupMatch.match_order)
    ).all() if match_ids else []
    teams_for_history = {team.id: team for team in db.session.scalars(select(Team)).all()}
    return jsonify(
        player={
            **_public_player(player),
            "teams": [_public_team(team_map[row.team_id]) for row in memberships if row.team_id in team_map],
            "statistics": {**stat, "appearances": len(appearances)},
            "matches": [_match_dict(row, teams_for_history, include_events=False) for row in history],
        }
    )


@cup_api.get("/teams/<int:team_id>")
def public_team(team_id):
    team = db.session.get(Team, team_id)
    if team is None:
        raise CupError("Team not found.", 404)
    memberships = db.session.scalars(
        select(CupRosterMembership).join(CupTournament).where(
            CupRosterMembership.team_id == team_id,
            CupRosterMembership.active.is_(True),
            CupTournament.lifecycle != "archived",
        )
    ).all()
    player_map = {player.id: player for player in db.session.scalars(select(Player)).all()}
    captain_ids = _auction_captain_ids({team.id: team}, player_map, memberships)
    match_rows = db.session.scalars(
        select(CupMatch).join(CupTournament).where(
            (CupMatch.home_team_id == team_id) | (CupMatch.away_team_id == team_id),
            CupMatch.state != "archived",
            CupTournament.lifecycle != "archived",
        ).order_by(CupMatch.match_order)
    ).all()
    tournament = _tournament(match_rows[0].tournament_id) if match_rows else None
    return jsonify(team={
        **_public_team(team),
        "captain_player_id": captain_ids.get(team.id),
        "players": [_public_player(player_map[row.player_id]) for row in memberships if row.player_id in player_map],
        "matches": [_match_dict(row) for row in match_rows],
        "tournament_id": tournament.id if tournament else None,
    })


@cup_api.post("/host/tournaments")
@host_required
def create_tournament():
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data = _body()
    request_id = _request_id(data)
    _lock_request_id(request_id)
    previous = _existing_request(request_id, "tournament_create", data)
    if previous is not None:
        return jsonify(previous), 201
    name = data.get("name", "Venoms Internal Cup")
    edition = data.get("edition", "1st Edition")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
        raise CupError("name must contain 1 to 120 characters.", 400)
    if not isinstance(edition, str) or not 1 <= len(edition.strip()) <= 80:
        raise CupError("edition must contain 1 to 80 characters.", 400)
    tournament = CupTournament(
        name=name.strip(),
        edition=edition.strip(),
        lifecycle="draft",
        timezone="Asia/Kolkata",
        version=0,
        settings={
            "points_win": 3,
            "points_draw": 1,
            "players_per_side": 5,
            "half_minutes": 10,
            "break_minutes": 5,
            "between_match_rest_minutes": 15,
            "playoff_rest_minutes": 60,
            "tie_resolutions": [],
        },
        created_at=_now(),
    )
    db.session.add(tournament)
    db.session.flush()
    response = {"tournament_id": tournament.id, "version": 0}
    host = current_host_session()
    db.session.add(CupAudit(
        tournament_id=tournament.id, request_id=request_id, action="tournament_create",
        actor_hash=host.token_hash if host else None, expected_version=0,
        details={
            "response": response,
            "after": {"type": "lifecycle", "tournament_id": tournament.id, "value": "draft"},
            "request_identity": _request_identity("tournament_create", data),
        },
        inverse={"type": "lifecycle", "tournament_id": tournament.id, "value": "archived"},
        created_at=_now(),
    ))
    db.session.commit()
    return jsonify(response), 201


def _mutating_request(action):
    data = _body()
    request_id = _request_id(data)
    _lock_request_id(request_id)
    previous = _existing_request(request_id, action, data)
    if previous is not None:
        return data, request_id, previous
    return data, request_id, None


def _recheck_after_lock(request_id, action, data):
    return _existing_request(request_id, action, data)


@cup_api.get("/host/archived-tournaments")
@host_required
def archived_tournaments():
    rows = db.session.scalars(select(CupTournament).where(
        CupTournament.lifecycle == "archived",
    ).order_by(CupTournament.id.desc())).all()
    return jsonify(tournaments=[{
        "id": row.id, "name": row.name, "edition": row.edition,
    } for row in rows])


@cup_api.get("/host/<int:tournament_id>/removal")
@host_required
def tournament_removal_status(tournament_id):
    tournament = _tournament(tournament_id, include_archived=True)
    archive_id = db.session.scalar(select(CupAudit.id).where(
        CupAudit.tournament_id == tournament.id,
        CupAudit.action == "tournament_archive", CupAudit.undone_by_id.is_(None),
    ).order_by(CupAudit.id.desc()).limit(1))
    active_match_id = db.session.scalar(select(CupMatch.id).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.state.in_(["live", "paused", "review"]),
    ).limit(1))
    return jsonify(tournament={
        "id": tournament.id, "name": tournament.name, "version": tournament.version,
        "lifecycle": "paused" if _tournament_paused(tournament) else tournament.lifecycle,
        "archive_audit_id": archive_id, "active_match_id": active_match_id,
    })


@cup_api.post("/host/<int:tournament_id>/archive")
@host_required
def archive_tournament(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("tournament_archive")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "tournament_archive", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    active = db.session.scalar(select(CupMatch.id).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.state.in_(["live", "paused", "review"]),
    ).limit(1))
    if active is not None:
        raise CupError("Finalize or undo the active or under-review match before removing this tournament.")
    old = tournament.lifecycle
    tournament.lifecycle = "archived"
    result = _record(
        tournament, request_id, "tournament_archive", expected,
        {"type": "lifecycle", "tournament_id": tournament.id, "value": old},
        {"type": "lifecycle", "tournament_id": tournament.id, "value": "archived"},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.get("/host/requests/<request_id>")
@host_required
def request_status(request_id):
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,64}", request_id):
        raise CupError("request_id is invalid.", 400)
    _lock_request_id(request_id)
    row = db.session.scalar(select(CupAudit).where(CupAudit.request_id == request_id))
    if row is None:
        return jsonify(request_id=request_id, status="not_committed")
    if row.action == "request_cancelled":
        return jsonify(request_id=request_id, status="cancelled", tournament_id=row.tournament_id)
    return jsonify(
        request_id=request_id, status="committed", action=row.action,
        tournament_id=row.tournament_id,
        resource=(row.details.get("request_identity") or {}).get("resource"),
        response=row.details.get("response", {}),
    )


@cup_api.post("/host/requests/<request_id>/cancel")
@host_required
def cancel_request(request_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data = _body()
    if _request_id(data) != request_id:
        raise CupError("request_id must match the cancellation URL.", 400)
    tournament_id = data.get("tournament_id")
    if type(tournament_id) is not int:
        raise CupError("A tournament is required to safely cancel this pending request.", 400)
    _lock_request_id(request_id)
    existing = db.session.scalar(select(CupAudit).where(CupAudit.request_id == request_id))
    if existing is not None:
        if existing.action == "request_cancelled":
            return jsonify(request_id=request_id, status="cancelled", tournament_id=existing.tournament_id)
        return jsonify(
            request_id=request_id, status="committed", action=existing.action,
            tournament_id=existing.tournament_id,
            resource=(existing.details.get("request_identity") or {}).get("resource"),
            response=existing.details.get("response", {}),
        )

    tournament = _tournament(tournament_id, lock=True, include_archived=True)
    response = {
        "request_id": request_id,
        "status": "cancelled",
        "tournament_id": tournament.id,
    }
    db.session.add(CupAudit(
        tournament_id=tournament.id,
        request_id=request_id,
        action="request_cancelled",
        actor_hash=(current_host_session().token_hash if current_host_session() else None),
        expected_version=tournament.version,
        details={
            "response": response,
            "request_identity": _request_identity("request_cancelled", data),
        },
        inverse={},
        created_at=_now(),
    ))
    db.session.commit()
    return jsonify(response)


@cup_api.post("/host/<int:tournament_id>/settings")
@host_required
def update_settings(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("settings_update")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "settings_update", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if tournament.lifecycle != "draft":
        raise CupError("Match settings are locked after fixtures are published.")
    incoming = data.get("settings")
    if not isinstance(incoming, dict):
        raise CupError("settings must be an object.", 400)
    allowed = {
        "players_per_side": (1, 30),
        "half_minutes": (1, 90),
        "break_minutes": (0, 60),
        "between_match_rest_minutes": (0, 180),
        "playoff_rest_minutes": (1, 1440),
    }
    settings = deepcopy(tournament.settings)
    for key, limits in allowed.items():
        if key in incoming:
            value = incoming[key]
            if type(value) is not int or not limits[0] <= value <= limits[1]:
                raise CupError(f"{key} must be between {limits[0]} and {limits[1]}.", 400)
            settings[key] = value
    old = deepcopy(tournament.settings)
    tournament.settings = settings
    result = _record(
        tournament, request_id, "settings_update", expected,
        {"type": "settings", "tournament_id": tournament_id, "value": old},
        {"type": "settings", "tournament_id": tournament_id, "value": settings},
        {"changed": list(incoming)},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/import-squads")
@host_required
def import_squads(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("squad_import")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "squad_import", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if tournament.lifecycle != "draft":
        raise CupError("Squads can only be imported while the tournament is a draft.")
    auction = db.session.get(Auction, 1)
    if auction is None:
        raise CupError("The completed auction is not available in this database.", 409)
    if auction.state.get("status") != "completed":
        raise CupError("Complete the auction before importing its cup squads.", 409)
    source_teams = db.session.scalars(select(AuctionTeam).order_by(AuctionTeam.id)).all()
    source_players = db.session.scalars(select(AuctionPlayer).order_by(AuctionPlayer.id)).all()
    sales = auction.state.get("sales", {})
    captains = auction.state.get("captains", {})
    assignments = {}
    for player_key, sale in sales.items():
        assignments[int(player_key)] = int(sale["team_id"])
    for team_key, captain in captains.items():
        assignments[int(captain["player_id"])] = int(team_key)
    if set(assignments.values()) - {team.id for team in source_teams}:
        raise CupError("Auction assignments reference an unknown team.", 409)
    if set(assignments) - {player.id for player in source_players}:
        raise CupError("Auction assignments reference an unknown player.", 409)
    already_imported = db.session.scalar(select(CupRosterMembership.id).where(
        CupRosterMembership.tournament_id == tournament.id,
        CupRosterMembership.active.is_(True),
    ).limit(1))
    if already_imported:
        raise CupError("Cup squads have already been imported. Use audited roster edits instead.")
    _lock_cup_identities()
    cup_teams = {row.auction_team_id: row for row in db.session.scalars(select(Team)).all()
                 if row.auction_team_id is not None}
    cup_players = {row.auction_player_id: row for row in db.session.scalars(select(Player)).all()
                   if row.auction_player_id is not None}
    next_team_id = (db.session.scalar(select(func.max(Team.id))) or 0) + 1
    next_player_id = (db.session.scalar(select(func.max(Player.id))) or 0) + 1
    for source in source_teams:
        if source.id not in cup_teams:
            identity = Team(id=next_team_id, auction_team_id=source.id, name=source.name, logo_path=source.logo_path)
            next_team_id += 1
            db.session.add(identity)
            cup_teams[source.id] = identity
    for source in source_players:
        if source.id not in cup_players:
            identity = Player(id=next_player_id, auction_player_id=source.id, name=source.name,
                              photo_path=source.photo_path, position=source.position, active=True)
            next_player_id += 1
            db.session.add(identity)
            cup_players[source.id] = identity
    db.session.flush()
    membership_rows = [
        CupRosterMembership(
            tournament_id=tournament.id, team_id=cup_teams[team_id].id, player_id=cup_players[player_id].id,
            active=True, created_at=_now(),
        )
        for player_id, team_id in sorted(assignments.items())
    ]
    db.session.add_all(membership_rows)
    db.session.flush()
    ids = [row.id for row in membership_rows]
    result = _record(
        tournament, request_id, "squad_import", expected,
        {"type": "memberships", "ids": ids, "active": False},
        {"type": "memberships", "ids": ids, "active": True},
        {"assigned_count": len(ids), "available_count": max(0, len(source_players) - len(ids))},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/rosters")
@host_required
def update_roster(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("roster_change")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "roster_change", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    _lock_cup_identities()
    if tournament.lifecycle not in {"draft", "published", "running", "completed"}:
        raise CupError("This tournament cannot be edited.")
    team_id, player_id = data.get("team_id"), data.get("player_id")
    if type(player_id) is not int or (team_id is not None and type(team_id) is not int):
        raise CupError("player_id must be an integer and team_id must be an integer or null.", 400)
    player = db.session.get(Player, player_id)
    if player is None or not player.active:
        raise CupError("Player not found.", 404)
    if team_id is not None and db.session.get(Team, team_id) is None:
        raise CupError("Team not found.", 404)
    existing = db.session.scalars(select(CupRosterMembership).where(
        CupRosterMembership.tournament_id == tournament.id,
        CupRosterMembership.player_id == player_id,
        CupRosterMembership.active.is_(True),
    )).all()
    if existing and any(row.team_id != team_id for row in existing):
        dependent = db.session.scalar(
            select(CupMatch.id).join(CupParticipation).where(
                CupMatch.tournament_id == tournament.id,
                CupMatch.state.in_(["draft", "scheduled", "live", "paused", "review"]),
                CupParticipation.player_id == player_id,
            ).limit(1)
        )
        if dependent is not None:
            raise CupError(
                "This player is in an upcoming or unfinished match lineup. "
                "Undo or correct that lineup before changing their squad."
            )
    old_rows = [
        {"id": row.id, "team_id": row.team_id, "player_id": row.player_id}
        for row in existing
    ]
    if team_id is None and not existing:
        raise CupError("The player is not assigned to a cup squad.")
    for row in existing:
        row.active = False
        row.ended_at = _now()
    membership = None
    if team_id is not None:
        membership = CupRosterMembership(
            tournament_id=tournament.id, team_id=team_id, player_id=player_id,
            active=True, created_at=_now(),
        )
        db.session.add(membership)
        db.session.flush()
    result = _record(
        tournament, request_id, "roster_change", expected,
        {"type": "membership_states", "states": [
            *[{"id": row["id"], "active": True} for row in old_rows],
            *([{"id": membership.id, "active": False}] if membership else []),
        ]},
        {"type": "membership_states", "states": [
            *[{"id": row["id"], "active": False} for row in old_rows],
            *([{"id": membership.id, "active": True}] if membership else []),
        ]},
        {"player_id": player_id, "team_id": team_id, "previous": old_rows},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/profiles")
@host_required
def update_cup_profile(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("cup_profile")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "cup_profile", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    _lock_cup_identities()
    entity, profile_id = data.get("entity"), data.get("id")
    if entity not in {"player", "team"} or (profile_id is not None and type(profile_id) is not int):
        raise CupError("Choose a player or team profile.", 400)
    if entity == "team" and profile_id is None:
        raise CupError("Choose an existing cup team.", 400)
    name = data.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120 or any(
        ord(character) < 32 or ord(character) == 127 for character in name
    ):
        raise CupError("Provide a valid name of at most 120 characters.", 400)
    model = Player if entity == "player" else Team
    profile = db.session.get(model, profile_id) if profile_id is not None else None
    if profile_id is not None and (profile is None or (entity == "player" and not profile.active)):
        raise CupError("Tournament profile not found.", 404)
    if profile_id is not None:
        foreign_use = db.session.scalar(select(CupRosterMembership.id).where(
            CupRosterMembership.tournament_id != tournament.id,
            (CupRosterMembership.player_id == profile_id) if entity == "player"
            else (CupRosterMembership.team_id == profile_id),
        ).limit(1))
        if foreign_use is not None:
            raise CupError("This profile is used by another tournament and cannot be changed here.")

    fields = {"name": name.strip()}
    if entity == "player":
        position = data.get("position")
        if not isinstance(position, str) or position not in {"GK", "DEF", "MID", "ST"}:
            raise CupError("Choose GK, DEF, MID or ST.", 400)
        fields["position"] = position
    image_field = "photo_path" if entity == "player" else "logo_path"
    image = data.get(image_field, getattr(profile, image_field, "") if profile else "")
    if not isinstance(image, str) or len(image) > 500:
        raise CupError("Invalid image path.", 400)
    if image and (profile is None or image != getattr(profile, image_field)):
        try:
            image_valid = valid_media_path(image) or valid_cup_media_path(image)
        except ValueError:
            current_app.logger.error("Cup image folder overlaps the auction image folder.")
            raise CupError("Cup image storage is misconfigured.", 503) from None
        if not image_valid:
            raise CupError("Choose an available local image.", 400)
    fields[image_field] = image
    if profile is None:
        profile_id = (db.session.scalar(select(func.max(Player.id))) or 0) + 1
        profile = Player(id=profile_id, auction_player_id=None, active=True, **fields)
        db.session.add(profile)
        before = {"active": False}
        after = {**fields, "active": True}
    else:
        before = {field: getattr(profile, field) for field in fields}
        after = fields
        for field, value in fields.items():
            setattr(profile, field, value)
    db.session.flush()
    result = _record(
        tournament, request_id, "cup_profile", expected,
        {"type": "cup_profile", "entity": entity, "id": profile.id, "values": before},
        {"type": "cup_profile", "entity": entity, "id": profile.id, "values": after},
        {"entity": entity, "profile_id": profile.id},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/fixtures")
@host_required
def generate_fixtures(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("fixtures_generate")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "fixtures_generate", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if tournament.lifecycle != "draft":
        raise CupError("Fixtures can only be generated while the tournament is a draft.")
    memberships = db.session.scalars(select(CupRosterMembership).where(
        CupRosterMembership.tournament_id == tournament.id,
        CupRosterMembership.active.is_(True),
    )).all()
    team_ids = sorted({row.team_id for row in memberships})
    if len(team_ids) != 5:
        raise CupError("Import or assign cup squads for exactly five teams before generating fixtures.")
    kickoff_text = data.get("kickoff")
    if not isinstance(kickoff_text, str):
        raise CupError("kickoff must be an ISO-8601 datetime with timezone.", 400)
    try:
        kickoff = datetime.fromisoformat(kickoff_text.replace("Z", "+00:00"))
    except ValueError:
        raise CupError("kickoff must be a valid ISO-8601 datetime.", 400) from None
    if kickoff.tzinfo is None:
        raise CupError("kickoff must include a timezone offset.", 400)
    kickoff = kickoff.astimezone(timezone.utc)
    settings = tournament.settings
    duration = settings["half_minutes"] * 2 + settings["break_minutes"]
    scheduled = schedule_fixtures(
        team_ids, kickoff, duration, settings["between_match_rest_minutes"]
    )
    if db.session.scalar(select(CupMatch.id).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.state != "archived",
    )):
        raise CupError("Fixtures already exist. Reorder or regenerate them through audited host controls.")
    first_order = (db.session.scalar(select(func.max(CupMatch.match_order)).where(
        CupMatch.tournament_id == tournament.id
    )) or 0) + 1
    matches = [
        CupMatch(
            tournament_id=tournament.id, stage="league",
            home_team_id=row["home_team_id"], away_team_id=row["away_team_id"],
            match_order=first_order + row["match_order"] - 1,
            scheduled_at=row["scheduled_at"],
            state="draft", settings={}, version=0, clock={},
        )
        for row in scheduled
    ]
    db.session.add_all(matches)
    db.session.flush()
    ids = [row.id for row in matches]
    result = _record(
        tournament, request_id, "fixtures_generate", expected,
        {"type": "matches", "ids": ids, "state": "archived"},
        {"type": "matches", "ids": ids, "state": "draft"},
        {"match_ids": ids},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/fixtures/reorder")
@host_required
def reorder_fixtures(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("fixtures_reorder")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "fixtures_reorder", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if tournament.lifecycle not in {"draft", "published", "running"}:
        raise CupError("Fixtures cannot be edited in this tournament state.")
    match_ids = data.get("match_ids")
    if (
        not isinstance(match_ids, list)
        or len(match_ids) != 10
        or any(type(match_id) is not int for match_id in match_ids)
        or len(set(match_ids)) != 10
    ):
        raise CupError("match_ids must list each of the ten league fixtures exactly once.", 400)
    matches = db.session.scalars(select(CupMatch).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.stage == "league",
        CupMatch.state != "archived",
    )).all()
    by_id = {match.id: match for match in matches}
    if len(matches) != 10 or set(match_ids) != set(by_id):
        raise CupError("All ten league fixtures must be present.")
    ordered = [by_id[match_id] for match_id in match_ids]
    original_order = sorted(matches, key=lambda match: match.match_order)
    if any(
        old.id != new.id and (old.state not in {"draft", "scheduled"} or new.state not in {"draft", "scheduled"})
        for old, new in zip(original_order, ordered)
    ):
        raise CupError("Started and completed matches must retain their positions.")
    if not any(match.state in {"draft", "scheduled"} for match in matches):
        raise CupError("There are no upcoming fixtures to edit.")
    kickoff_text = data.get("kickoff")
    if not isinstance(kickoff_text, str):
        raise CupError("kickoff must be an ISO-8601 datetime with timezone.", 400)
    try:
        kickoff = datetime.fromisoformat(kickoff_text.replace("Z", "+00:00"))
    except ValueError:
        raise CupError("kickoff must be a valid ISO-8601 datetime.", 400) from None
    if kickoff.tzinfo is None:
        raise CupError("kickoff must include a timezone offset.", 400)
    settings = tournament.settings
    duration = (
        settings["half_minutes"] * 2 + settings["break_minutes"]
        + settings["between_match_rest_minutes"]
    )
    gap = timedelta(minutes=duration)
    pending = [match for match in ordered if match.state in {"draft", "scheduled"}]
    pending_slots = [match.match_order for match in original_order if match.state in {"draft", "scheduled"}]
    before = [
        {"id": match.id, "match_order": match.match_order,
         "scheduled_at": match.scheduled_at.isoformat() if match.scheduled_at else None}
        for match in pending
    ]
    for match in pending:
        match.match_order = -match.id
    db.session.flush()
    for index, (match, slot) in enumerate(zip(pending, pending_slots)):
        match.match_order = slot
        match.scheduled_at = kickoff.astimezone(timezone.utc) + index * gap
        match.version += 1
    after = [
        {"id": match.id, "match_order": match.match_order,
         "scheduled_at": match.scheduled_at.isoformat() if match.scheduled_at else None}
        for match in pending
    ]
    result = _record(
        tournament, request_id, "fixtures_reorder", expected,
        {"type": "fixture_schedule", "rows": before},
        {"type": "fixture_schedule", "rows": after},
        {"match_ids": match_ids},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/playoffs")
@host_required
def generate_playoffs(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("playoffs_generate")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "playoffs_generate", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    league = db.session.scalars(select(CupMatch).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.stage == "league",
        CupMatch.state != "archived",
    ).order_by(CupMatch.match_order)).all()
    if len(league) != 10 or any(match.state != "finalized" for match in league):
        raise CupError("Finalize all ten league matches before qualifying the playoffs.")
    detail = _tournament_dict(tournament)
    if detail["unresolved_tie"]:
        raise CupError("Resolve every exact league-table tie before qualifying the playoffs.")
    if any(match.stage != "league" for match in db.session.scalars(
        select(CupMatch).where(CupMatch.tournament_id == tournament.id, CupMatch.state != "archived")
    ).all()):
        raise CupError("Playoff fixtures have already been generated.")
    standings = detail["standings"]
    if len(standings) != 5:
        raise CupError("All five teams must be represented in the final league table.")
    kickoff_text = data.get("kickoff")
    try:
        kickoff = datetime.fromisoformat(kickoff_text.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        raise CupError("kickoff must be a valid ISO-8601 datetime.", 400) from None
    if kickoff.tzinfo is None:
        raise CupError("kickoff must include a timezone offset.", 400)
    latest_result = max(match.finalized_at for match in league if match.finalized_at)
    minimum_start = _as_utc(latest_result) + timedelta(minutes=tournament.settings["playoff_rest_minutes"])
    if kickoff.astimezone(timezone.utc) < minimum_start:
        raise CupError("The third-place match must respect the configured rest interval after league completion.")
    duration = tournament.settings["half_minutes"] * 2 + tournament.settings["break_minutes"]
    final_kickoff = kickoff + timedelta(
        minutes=duration + tournament.settings["between_match_rest_minutes"]
    )
    first_order = (db.session.scalar(select(func.max(CupMatch.match_order)).where(
        CupMatch.tournament_id == tournament.id
    )) or 0) + 1
    matches = [
        CupMatch(
            tournament_id=tournament.id, stage="third_place",
            home_team_id=standings[2]["id"], away_team_id=standings[3]["id"],
            match_order=first_order, scheduled_at=kickoff, state="scheduled",
            settings={}, version=0, clock={},
        ),
        CupMatch(
            tournament_id=tournament.id, stage="final",
            home_team_id=standings[0]["id"], away_team_id=standings[1]["id"],
            match_order=first_order + 1, scheduled_at=final_kickoff, state="scheduled",
            settings={}, version=0, clock={},
        ),
    ]
    db.session.add_all(matches)
    db.session.flush()
    match_ids = [match.id for match in matches]
    result = _record(
        tournament, request_id, "playoffs_generate", expected,
        {"type": "matches", "ids": match_ids, "state": "archived"},
        {"type": "matches", "ids": match_ids, "state": "scheduled"},
        {"match_ids": match_ids, "third_place_kickoff": kickoff.isoformat(),
         "final_kickoff": final_kickoff.isoformat()},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/matches/<int:match_id>/reschedule")
@host_required
def reschedule_playoff(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("playoff_reschedule")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "playoff_reschedule", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if match.stage not in {"third_place", "final"} or match.state != "scheduled":
        raise CupError("Only an upcoming playoff can be rescheduled.")
    try:
        kickoff = datetime.fromisoformat(data["kickoff"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, TypeError, ValueError):
        raise CupError("kickoff must be a valid ISO-8601 datetime.", 400) from None
    if kickoff.tzinfo is None:
        raise CupError("kickoff must include a timezone offset.", 400)
    kickoff = kickoff.astimezone(timezone.utc)
    matches = db.session.scalars(select(CupMatch).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.state != "archived",
    ).order_by(CupMatch.match_order)).all()
    previous_matches = [row for row in matches if row.match_order < match.match_order]
    next_matches = [row for row in matches if row.match_order > match.match_order]
    previous_match = previous_matches[-1] if previous_matches else None
    if previous_match is None:
        raise CupError("The preceding match is missing.")
    rest = tournament.settings["playoff_rest_minutes"] if match.stage == "third_place" else tournament.settings["between_match_rest_minutes"]
    duration = tournament.settings["half_minutes"] * 2 + tournament.settings["break_minutes"]
    if previous_match.finalized_at:
        earliest = _as_utc(previous_match.finalized_at) + timedelta(minutes=rest)
    elif previous_match.scheduled_at:
        earliest = _as_utc(previous_match.scheduled_at) + timedelta(minutes=duration + rest)
    else:
        raise CupError("The preceding match has no scheduled kickoff.")
    if kickoff < earliest:
        raise CupError("The kickoff must respect the preceding match and configured rest interval.", 400)
    if next_matches:
        next_match = next_matches[0]
        if next_match.scheduled_at is None or kickoff + timedelta(
            minutes=duration + tournament.settings["between_match_rest_minutes"]
        ) > _as_utc(next_match.scheduled_at):
            raise CupError("The kickoff must leave enough time before the next match.", 400)
    before = {"id": match.id, "match_order": match.match_order,
              "scheduled_at": match.scheduled_at.isoformat() if match.scheduled_at else None}
    match.scheduled_at = kickoff
    match.version += 1
    after = {"id": match.id, "match_order": match.match_order, "scheduled_at": kickoff.isoformat()}
    result = _record(
        tournament, request_id, "playoff_reschedule", expected,
        {"type": "fixture_schedule", "rows": [before]},
        {"type": "fixture_schedule", "rows": [after]},
        {"match_id": match.id, "kickoff": kickoff.isoformat()},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/publish")
@host_required
def publish_fixtures(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("fixtures_publish")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "fixtures_publish", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if tournament.lifecycle != "draft":
        raise CupError("Only draft fixtures can be published.")
    matches = db.session.scalars(select(CupMatch).where(
        CupMatch.tournament_id == tournament.id,
        CupMatch.stage == "league",
        CupMatch.state == "draft",
    ).order_by(CupMatch.match_order)).all()
    if len(matches) != 10:
        raise CupError("Generate all ten league fixtures before publishing.")
    for row in matches:
        row.state = "scheduled"
    old_lifecycle = tournament.lifecycle
    tournament.lifecycle = "published"
    result = _record(
        tournament, request_id, "fixtures_publish", expected,
        {"type": "tournament_match_states", "tournament_id": tournament.id,
         "lifecycle": old_lifecycle, "matches": [[row.id, "draft"] for row in matches]},
        {"type": "tournament_match_states", "tournament_id": tournament.id,
         "lifecycle": "published", "matches": [[row.id, "scheduled"] for row in matches]},
        {"match_ids": [row.id for row in matches]},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/start")
@host_required
def start_tournament(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("tournament_start")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "tournament_start", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if tournament.lifecycle != "published":
        raise CupError("Publish the reviewed fixture list before starting the tournament.")
    old = tournament.lifecycle
    tournament.lifecycle = "running"
    result = _record(
        tournament, request_id, "tournament_start", expected,
        {"type": "lifecycle", "tournament_id": tournament.id, "value": old},
        {"type": "lifecycle", "tournament_id": tournament.id, "value": "running"},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/control")
@host_required
def control_tournament(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("tournament_control")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "tournament_control", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    command = data.get("command")
    allowed = {"pause": {"running"}, "resume": {"paused"}, "finish": {"running", "paused"}}
    lifecycle = "paused" if _tournament_paused(tournament) else tournament.lifecycle
    if command not in allowed or lifecycle not in allowed[command]:
        raise CupError("That tournament control is not available in the current state.")
    matches = db.session.scalars(select(CupMatch).where(
        CupMatch.tournament_id == tournament.id, CupMatch.state != "archived",
    ).order_by(CupMatch.id).with_for_update()).all()
    if command == "finish":
        if not (
            len(matches) == 12
            and sum(row.stage == "league" for row in matches) == 10
            and sum(row.stage == "final" for row in matches) == 1
            and sum(row.stage == "third_place" for row in matches) == 1
            and all(row.state == "finalized" for row in matches)
        ):
            raise CupError("Finalize all ten league fixtures, the third-place match and the final before finishing the tournament.")
        if data.get("confirm") is not True:
            raise CupError("Confirm that the completed tournament should be finished.", 400)
    now = _now()

    def snapshot(row):
        clock = deepcopy(row.clock)
        if clock.get("anchor"):
            clock["elapsed_seconds"] = _elapsed_seconds(clock, now)
            clock["anchor"] = now.isoformat()
        if clock.get("break_started_at"):
            clock["break_elapsed_seconds"] = max(
                0, int((now - _as_utc(datetime.fromisoformat(clock.pop("break_started_at")))).total_seconds())
            )
        return {"type": "clock", "match_id": row.id, "state": row.state, "clock": clock}

    affected = [row for row in matches if row.state in {"live", "paused"}]
    before = {"type": "tournament_control", "tournament_id": tournament.id,
              "lifecycle": tournament.lifecycle, "paused": _tournament_paused(tournament),
              "matches": [snapshot(row) for row in affected]}
    tournament.lifecycle = "completed" if command == "finish" else "running"
    tournament.settings = {**tournament.settings, "tournament_paused": command == "pause"}
    for row in affected:
        saved = snapshot(row)
        if command == "pause":
            row.state = "paused"
            row.clock = {**saved["clock"], "anchor": None, "paused": True}
            row.version += 1
        elif command == "resume" and "break_elapsed_seconds" in row.clock:
            clock = deepcopy(row.clock)
            clock["break_started_at"] = (now - timedelta(seconds=clock.pop("break_elapsed_seconds"))).isoformat()
            row.clock = clock
            row.version += 1
    after = {"type": "tournament_control", "tournament_id": tournament.id,
             "lifecycle": tournament.lifecycle, "paused": _tournament_paused(tournament),
             "matches": [snapshot(row) for row in affected]}
    result = _record(tournament, request_id, "tournament_control", expected, before, after, {"command": command})
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/<int:tournament_id>/tie-resolution")
@host_required
def tie_resolution(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("tie_resolution")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True)
    previous = _recheck_after_lock(request_id, "tie_resolution", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    finalized_league_count = db.session.scalar(
        select(func.count(CupMatch.id)).where(
            CupMatch.tournament_id == tournament.id,
            CupMatch.stage == "league",
            CupMatch.state == "finalized",
        )
    )
    if finalized_league_count != 10:
        raise CupError("Ranking decisions are only available after all ten league matches are finalized.")
    team_orders = data.get("team_orders")
    if team_orders is None and isinstance(data.get("team_order"), list):
        team_orders = [data["team_order"]]
    if not isinstance(team_orders, list) or any(
        not isinstance(group, list) or not group or any(type(value) is not int for value in group)
        for group in team_orders
    ):
        raise CupError("team_orders must be an array of tied-team id arrays.", 400)
    detail = _tournament_dict(tournament)
    raw_table = compute_standings(
        detail["teams"], detail["matches"], [], allow_unresolved=True
    )
    tied_groups = []
    current = []
    for row in raw_table:
        if current and row["rank"] != current[0]["rank"]:
            if len(current) > 1:
                tied_groups.append({item["id"] for item in current})
            current = []
        current.append(row)
    if len(current) > 1:
        tied_groups.append({item["id"] for item in current})
    if len(team_orders) != len(tied_groups) or any(
        len(order) != len(tied)
        or len(set(order)) != len(order)
        or set(order) != tied
        for order, tied in zip(team_orders, tied_groups)
    ):
        raise CupError("Resolve each exact standings tie with precisely its tied teams.", 400)
    settings = deepcopy(tournament.settings)
    settings["tie_resolutions"] = team_orders
    old = deepcopy(tournament.settings)
    tournament.settings = settings
    result = _record(
        tournament, request_id, "tie_resolution", expected,
        {"type": "settings", "tournament_id": tournament.id, "value": old},
        {"type": "settings", "tournament_id": tournament.id, "value": settings},
        {"team_orders": team_orders},
    )
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/matches/<int:match_id>/lineup")
@host_required
def set_lineup(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("match_lineup")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "match_lineup", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before editing the lineup.")
    if match.state not in {"scheduled", "draft"} or _events_for_match(match.id):
        raise CupError("The lineup is locked after match events begin.")
    rows = data.get("players")
    if not isinstance(rows, list) or not rows:
        raise CupError("players must be a non-empty array.", 400)
    old = _lineup_snapshot(match.id)
    seen = set()
    teams = {match.home_team_id, match.away_team_id}
    active_roster = {
        (row.player_id, row.team_id)
        for row in db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament.id,
            CupRosterMembership.active.is_(True),
        )).all()
    }
    normalized = []
    for item in rows:
        if not isinstance(item, dict):
            raise CupError("Every lineup entry must be an object.", 400)
        player_id, team_id = item.get("player_id"), item.get("team_id")
        status = item.get("status", "starter")
        goalkeeper = item.get("goalkeeper", False)
        if type(player_id) is not int or type(team_id) is not int or team_id not in teams:
            raise CupError("Lineup players must belong to a participating team.", 400)
        if (player_id, team_id) not in active_roster:
            raise CupError("Every lineup player must be in that team's active cup roster.", 400)
        if player_id in seen:
            raise CupError("A player can appear only once in the lineup.", 400)
        if status not in {"starter", "bench"} or type(goalkeeper) is not bool:
            raise CupError("Lineup status or goalkeeper selection is invalid.", 400)
        seen.add(player_id)
        normalized.append({
            "player_id": player_id, "team_id": team_id, "status": status,
            "goalkeeper": goalkeeper,
        })
    max_players = tournament.settings["players_per_side"]
    for team_id in teams:
        side = [row for row in normalized if row["team_id"] == team_id]
        if len([row for row in side if row["status"] == "starter"]) != max_players:
            raise CupError(f"Select exactly {max_players} starters for each team.", 400)
        if len([row for row in side if row["goalkeeper"] and row["status"] == "starter"]) != 1:
            raise CupError("Select exactly one active starting goalkeeper for each team.", 400)
    for old_row in db.session.scalars(select(CupParticipation).where(
        CupParticipation.match_id == match.id
    )).all():
        db.session.delete(old_row)
    db.session.flush()
    for row in normalized:
        db.session.add(CupParticipation(
            match_id=match.id, team_id=row["team_id"], player_id=row["player_id"],
            status=row["status"], goalkeeper=row["goalkeeper"],
        ))
    match.version += 1
    result = _record(
        tournament, request_id, "match_lineup", expected,
        {"type": "lineup", "match_id": match.id, "rows": old},
        {"type": "lineup", "match_id": match.id, "rows": [
            {**row, "entered_minute": None, "left_minute": None} for row in normalized
        ]},
        {"match_id": match.id, "players": normalized},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version})


@cup_api.post("/host/matches/<int:match_id>/bench")
@host_required
def add_remaining_bench(match_id):
    """Append missing eligible squad players to an active match bench without touching existing rows."""
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("match_bench")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "match_bench", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before updating the bench.")
    if match.state not in {"live", "paused"}:
        raise CupError("Remaining players can be added to the bench only while the match is in play.")
    old = _lineup_snapshot(match.id)
    if not old:
        raise CupError("Save the starting lineup before adding bench players.")
    listed = {row["player_id"] for row in old}
    missing = [
        {"player_id": row.player_id, "team_id": row.team_id}
        for row in db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament.id,
            CupRosterMembership.active.is_(True),
            CupRosterMembership.team_id.in_([match.home_team_id, match.away_team_id]),
        ).order_by(CupRosterMembership.team_id, CupRosterMembership.player_id)).all()
        if row.player_id not in listed
    ]
    if not missing:
        raise CupError("Every eligible squad player is already in this match.")
    for row in missing:
        db.session.add(CupParticipation(
            match_id=match.id, team_id=row["team_id"], player_id=row["player_id"],
            status="bench", goalkeeper=False,
        ))
    db.session.flush()
    match.version += 1
    result = _record(
        tournament, request_id, "match_bench", expected,
        {"type": "lineup", "match_id": match.id, "rows": old},
        {"type": "lineup", "match_id": match.id, "rows": _lineup_snapshot(match.id)},
        {"match_id": match.id, "added": missing},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version, "added": missing})


@cup_api.post("/host/matches/<int:match_id>/goalkeeper")
@host_required
def change_goalkeeper(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("goalkeeper_change")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "goalkeeper_change", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before changing the goalkeeper.")
    if match.state not in {"live", "paused"}:
        raise CupError("The active goalkeeper can only be changed during play.")
    team_id, player_id = data.get("team_id"), data.get("player_id")
    if type(team_id) is not int or team_id not in {match.home_team_id, match.away_team_id}:
        raise CupError("Choose one of the teams in this match.", 400)
    if type(player_id) is not int:
        raise CupError("Choose an active player as goalkeeper.", 400)
    participants = db.session.scalars(select(CupParticipation).where(
        CupParticipation.match_id == match.id,
        CupParticipation.team_id == team_id,
    )).all()
    keeper = next((row for row in participants if row.player_id == player_id), None)
    if keeper is None or keeper.status not in {"starter", "entered"}:
        raise CupError("The goalkeeper must be an active player on that team.")
    old = _lineup_snapshot(match.id)
    for participant in participants:
        participant.goalkeeper = participant.player_id == player_id
    match.version += 1
    result = _record(
        tournament, request_id, "goalkeeper_change", expected,
        {"type": "lineup", "match_id": match.id, "rows": old},
        {"type": "lineup", "match_id": match.id, "rows": _lineup_snapshot(match.id)},
        {"match_id": match.id, "team_id": team_id, "player_id": player_id},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version})


@cup_api.post("/host/matches/<int:match_id>/playoff-rules")
@host_required
def set_playoff_rules(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("playoff_rules")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "playoff_rules", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before updating playoff rules.")
    if match.stage == "league" or match.state != "scheduled":
        raise CupError("Draw-deciding rules can only be set for a scheduled playoff.")
    draw_method = data.get("draw_method")
    extra_time_minutes = data.get("extra_time_minutes", 0)
    shootout_kicks = data.get("shootout_kicks", 5)
    taker_rule = data.get("shootout_taker_rule", "rotate_active_players")
    if draw_method not in {"direct_penalties", "extra_time_penalties"}:
        raise CupError("Choose direct penalties or extra time followed by penalties.", 400)
    if type(extra_time_minutes) is not int or not 0 <= extra_time_minutes <= 30:
        raise CupError("extra_time_minutes must be between 0 and 30.", 400)
    if draw_method == "extra_time_penalties" and extra_time_minutes < 1:
        raise CupError("Extra-time duration must be configured before kickoff.", 400)
    if type(shootout_kicks) is not int or not 1 <= shootout_kicks <= 10:
        raise CupError("shootout_kicks must be between 1 and 10.", 400)
    if taker_rule not in {"rotate_active_players", "equal_players_only"}:
        raise CupError("Choose a supported penalty-taker rule.", 400)
    old_settings = deepcopy(match.settings)
    match.settings = {
        **match.settings,
        "draw_method": draw_method,
        "extra_time_minutes": extra_time_minutes,
        "shootout_kicks": shootout_kicks,
        "shootout_taker_rule": taker_rule,
    }
    match.version += 1
    result = _record(
        tournament, request_id, "playoff_rules", expected,
        {"type": "match_settings", "match_id": match.id, "settings": old_settings},
        {"type": "match_settings", "match_id": match.id, "settings": deepcopy(match.settings)},
        {"match_id": match.id, "draw_method": draw_method},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version})


@cup_api.post("/host/matches/<int:match_id>/clock")
@host_required
def match_clock(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("match_clock")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "match_clock", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh and reconcile before continuing.")
    command = data.get("command")
    now = _now()
    old_state, old_clock = match.state, deepcopy(match.clock)
    old_settings = deepcopy(match.settings)
    if old_state == "live" and old_clock.get("anchor"):
        old_clock["elapsed_seconds"] = _elapsed_seconds(old_clock, now)
        old_clock["anchor"] = now.isoformat()
    score = match_score(
        [_event_dict(event) for event in _events_for_match(match.id)],
        match.home_team_id, match.away_team_id,
    )
    if command == "kickoff" and match.state == "scheduled":
        _validate_kickoff(tournament, match)
        match.state = "live"
        match.clock = {"period": "first_half", "elapsed_seconds": 0, "anchor": now.isoformat(), "paused": False,
                       "played_seconds": 0}
    elif command == "pause" and match.state == "live":
        anchor = datetime.fromisoformat(match.clock["anchor"])
        elapsed = match.clock.get("elapsed_seconds", 0) + max(0, int((now - anchor).total_seconds()))
        match.clock = {**match.clock, "elapsed_seconds": elapsed, "anchor": None, "paused": True}
        match.state = "paused"
    elif command == "resume" and match.state == "paused":
        clock = deepcopy(match.clock)
        # Configured break and half lengths are reference targets; the host decides when play moves on.
        if clock.get("period") == "half_time_break":
            clock["period"] = "second_half"
            clock.pop("break_started_at", None)
            clock["elapsed_seconds"] = 0
        match.clock = {**clock, "anchor": now.isoformat(), "paused": False}
        match.state = "live"
    elif command == "end_period" and match.state in {"live", "paused"}:
        period = match.clock.get("period", "first_half")
        if period == "half_time_break":
            raise CupError("Start the second half to end the half-time break.")
        stored_played = match.clock.get("played_seconds")
        played_total = (stored_played if type(stored_played) is int else {
            "first_half": 0,
            "second_half": tournament.settings["half_minutes"] * 60,
            "extra_time_1": tournament.settings["half_minutes"] * 120,
            "extra_time_2": tournament.settings["half_minutes"] * 120
            + int(match.settings.get("extra_time_minutes", 0) or 0) * 60,
        }.get(period, 0)) + _elapsed_seconds(match.clock, now)
        if period == "first_half":
            match.clock = {
                "period": "half_time_break", "elapsed_seconds": 0, "anchor": None,
                "paused": True, "break_started_at": now.isoformat(), "played_seconds": played_total,
            }
            match.state = "paused"
            next_period = None
        elif period == "second_half" and match.stage != "league" and (
            score[match.home_team_id] == score[match.away_team_id]
        ):
            next_period = (
                "extra_time_1"
                if match.settings.get("draw_method") == "extra_time_penalties"
                else None
            )
            if next_period is None:
                match.state = "review"
                match.clock = {**match.clock, "period": "shootout", "anchor": None, "paused": True}
        elif period == "extra_time_1":
            next_period = "extra_time_2"
        else:
            match.state = "review"
            needs_shootout = (
                match.stage != "league"
                and score[match.home_team_id] == score[match.away_team_id]
            )
            match.clock = {**match.clock, "period": "shootout" if needs_shootout else "full_time",
                           "anchor": None, "paused": True}
            next_period = None
        if next_period:
            match.clock = {"period": next_period, "elapsed_seconds": 0, "anchor": None, "paused": True,
                           "played_seconds": played_total}
            match.state = "paused"
    elif command == "league_shootout" and match.stage == "league" and match.state in {"review", "finalized"}:
        if match.clock.get("period") != "full_time" or score[match.home_team_id] != score[match.away_team_id]:
            raise CupError("Penalties can only settle a league match that ended level at full time.")
        if match.state == "finalized":
            # Explicit host choice to settle an already-finalized draw; the original finish time keeps rest rules stable.
            if db.session.scalar(select(CupMatch.id).where(
                CupMatch.tournament_id == tournament.id, CupMatch.id != match.id,
                CupMatch.state.in_(["live", "paused", "review"]),
            ).limit(1)) is not None:
                raise CupError("Finish the match on the pitch before reopening a draw for penalties.")
            if db.session.scalar(select(CupMatch.id).where(
                CupMatch.tournament_id == tournament.id, CupMatch.stage != "league",
            ).limit(1)) is not None:
                raise CupError("Playoff fixtures are already set from the table, so league draws can no longer be reopened.")
            match.state = "review"
            match.settings = {**match.settings, "reopened_finalized_at":
                              _as_utc(match.finalized_at).isoformat() if match.finalized_at else None}
        kicks = data.get("shootout_kicks", 5)
        taker_rule = data.get("shootout_taker_rule", "rotate_active_players")
        if type(kicks) is not int or not 1 <= kicks <= 10:
            raise CupError("shootout_kicks must be between 1 and 10.", 400)
        if taker_rule not in {"rotate_active_players", "equal_players_only"}:
            raise CupError("Choose a supported penalty-taker rule.", 400)
        match.settings = {**match.settings, "league_shootout": True, "shootout_kicks": kicks,
                          "shootout_taker_rule": taker_rule}
        match.clock = {**match.clock, "period": "shootout"}
    elif command == "cancel_league_shootout" and match.stage == "league" and match.state == "review":
        if match.clock.get("period") != "shootout":
            raise CupError("This league match is not in a penalty shootout.")
        if match.settings.get("shootout_finish"):
            raise CupError("Undo the host's shootout finish before returning to a draw.")
        if any(event.event_type == "shootout" for event in _events_for_match(match.id)):
            raise CupError("Undo the recorded penalties before returning to a draw.")
        match.settings = {key: value for key, value in match.settings.items() if key != "league_shootout"}
        match.clock = {**match.clock, "period": "full_time"}
    else:
        raise CupError("That clock command is not valid for the current match state.")
    match.version += 1
    result = _record(
        tournament, request_id, "match_clock", expected,
        {"type": "clock", "match_id": match.id, "clock": old_clock, "state": old_state, "settings": old_settings},
        {"type": "clock", "match_id": match.id, "clock": deepcopy(match.clock), "state": match.state,
         "settings": deepcopy(match.settings)},
        {"match_id": match.id, "command": command},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version, "match_state": match.state, "clock": match.clock})


@cup_api.post("/host/matches/<int:match_id>/shootout")
@host_required
def add_shootout_attempt(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("shootout_attempt")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "shootout_attempt", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before recording a penalty.")
    if match.state != "review" or match.clock.get("period") != "shootout" or (
        match.stage == "league" and match.settings.get("league_shootout") is not True
    ):
        raise CupError("Shootout attempts are only available after a tied playoff or a league draw sent to penalties.")
    team_id, player_id, scored = data.get("team_id"), data.get("player_id"), data.get("scored")
    if team_id not in {match.home_team_id, match.away_team_id} or type(team_id) is not int:
        raise CupError("Choose one of the match teams.", 400)
    if type(player_id) is not int or type(scored) is not bool:
        raise CupError("A shootout attempt needs a player and a scored/missed result.", 400)
    eligible_by_team = _penalty_eligible(match)
    if player_id not in eligible_by_team[team_id]:
        raise CupError("The penalty taker must be an active assigned squad player who has not been dismissed.")
    if not eligible_by_team[match.home_team_id] or not eligible_by_team[match.away_team_id]:
        raise CupError("Each team needs an eligible squad player to take penalties.")
    taker_rule = match.settings.get("shootout_taker_rule", "rotate_active_players")
    if taker_rule == "equal_players_only" and len(eligible_by_team[match.home_team_id]) != len(
        eligible_by_team[match.away_team_id]
    ):
        raise CupError("This shootout rule requires equal numbers of eligible squad penalty takers.")
    attempts = db.session.scalars(select(CupMatchEvent).where(
        CupMatchEvent.match_id == match.id,
        CupMatchEvent.event_type == "shootout",
        CupMatchEvent.voided.is_(False),
    ).order_by(CupMatchEvent.id)).all()
    kicks_per_team = match.settings.get("shootout_kicks", 5)
    winner, home_count, away_count, home_score, away_score = _shootout_result(match, attempts)
    if winner is not None:
        raise CupError("The shootout already has a winner.")
    if home_count < kicks_per_team or away_count < kicks_per_team:
        if home_count == away_count:
            expected_team = match.home_team_id
        elif home_count == away_count + 1:
            expected_team = match.away_team_id
        else:
            raise CupError("Shootout attempts must alternate in order.")
    elif home_count == away_count:
        expected_team = match.home_team_id
    elif home_count == away_count + 1:
        expected_team = match.away_team_id
    else:
        raise CupError("Shootout attempts must alternate in order.")
    if team_id != expected_team:
        raise CupError("Shootout teams must take turns in order.")
    team_attempts = [row for row in attempts if row.team_id == team_id]
    eligible_ids = eligible_by_team[team_id]
    if player_id in _penalty_rotation_used(team_attempts, eligible_ids):
        raise CupError("A player cannot take another penalty until every eligible teammate has taken one.")
    event = CupMatchEvent(
        match_id=match.id, request_id=request_id, event_type="shootout",
        minute=0, period="shootout", team_id=team_id, player_id=player_id,
        payload={"scored": scored, "attempt": len(attempts) + 1},
        voided=False, created_at=_now(),
    )
    db.session.add(event)
    db.session.flush()
    match.version += 1
    result = _record(
        tournament, request_id, "shootout_attempt", expected,
        {"type": "event", "event_id": event.id, "voided": True, "participation": []},
        {"type": "event", "event_id": event.id, "voided": False, "participation": []},
        {"match_id": match.id, "event_id": event.id, "attempt": len(attempts) + 1},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version})


@cup_api.post("/host/matches/<int:match_id>/shootout/finish")
@host_required
def finish_shootout(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("shootout_finish")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "shootout_finish", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if match.version != _expected_version(data, "expected_match_version"):
        raise CupError("This match changed in another tab. Refresh before finishing penalties.")
    if match.state != "review" or match.clock.get("period") != "shootout" or (
        match.stage == "league" and match.settings.get("league_shootout") is not True
    ):
        raise CupError("This match is not awaiting a penalty shootout.")
    if match.settings.get("shootout_finish"):
        raise CupError("The host already finished this shootout. Undo that action to reopen it.")
    if data.get("confirm") is not True:
        raise CupError("Confirm that the shootout should finish with the recorded kicks unchanged.", 400)
    events = _events_for_match(match.id)
    regulation = match_score([_event_dict(event) for event in events], match.home_team_id, match.away_team_id)
    if regulation[match.home_team_id] != regulation[match.away_team_id]:
        raise CupError("A penalty shootout requires a tied regulation result. Review the match events first.")
    _, _, _, home, away = _shootout_result(match, events)
    winner = match.home_team_id if home > away else match.away_team_id if away > home else None
    selected = data.get("winner_team_id")
    if winner is None:
        if type(selected) is not int or selected not in {match.home_team_id, match.away_team_id}:
            raise CupError("The penalty scores are tied. Explicitly choose the team awarded the win.", 400)
        winner = selected
    elif selected is not None and (type(selected) is not int or selected != winner):
        raise CupError("The team leading the recorded shootout must be the winner.", 400)
    before = deepcopy(match.settings)
    finish = {
        "winner_team_id": winner, "home": home, "away": away,
        "host_decided": home == away, "finished_at": _now().isoformat(),
        "attempt_ids": [event.id for event in events if event.event_type == "shootout"],
    }
    match.settings = {**match.settings, "shootout_finish": finish}
    match.version += 1
    result = _record(
        tournament, request_id, "shootout_finish", expected,
        {"type": "match_settings", "match_id": match.id, "settings": before},
        {"type": "match_settings", "match_id": match.id, "settings": deepcopy(match.settings)},
        {"match_id": match.id, **finish}, match_id=match.id,
    )
    result["match_version"] = match.version
    db.session.commit()
    return jsonify(result)


@cup_api.post("/host/matches/<int:match_id>/events")
@host_required
def add_match_event(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("match_event")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "match_event", data)
    if previous is not None:
        return jsonify(previous)
    if match.settings.get("shootout_finish"):
        raise CupError("Undo the host's shootout finish before adding match events.")
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before retrying.")
    historical = data.get("historical", False)
    if type(historical) is not bool:
        raise CupError("historical must be true or false.", 400)
    if match.state not in ({"live", "paused", "review", "finalized"} if historical else {"live", "paused"}):
        raise CupError("Match events can only be recorded in a played match.")
    if historical and match.state == "finalized" and data.get("confirm_finalized") is not True:
        raise CupError("Confirm that this finalized result should be corrected.", 400)
    event_type = data.get("event_type")
    minute, period = data.get("minute"), data.get("period")
    team_id, player_id = data.get("team_id"), data.get("player_id")
    if not historical:
        # Live events are timed by the authoritative server clock, never by the host's device.
        minute = _match_minute(match, tournament, _now())
        if period is None:
            period = match.clock.get("period")
    if type(minute) is not int or not 0 <= minute <= 300:
        raise CupError("minute must be between 0 and 300.", 400)
    if period not in PERIODS:
        raise CupError("period is invalid.", 400)
    if historical:
        clock_periods = {
            row.details.get("after", {}).get("clock", {}).get("period")
            for row in _audit_rows(tournament.id)
            if row.match_id == match.id and row.action == "match_clock" and row.undone_by_id is None
        }
        if period not in clock_periods and period != match.clock.get("period"):
            raise CupError("Choose a period that was actually played.", 400)
        period_order = {"first_half": 0, "second_half": 1, "extra_time_1": 2, "extra_time_2": 3}
        existing_events = _events_for_match(match.id)
        if any(row.event_type == "shootout" for row in existing_events):
            raise CupError("Undo the dependent shootout before adding an omitted match event.")
        if any(
            period_order.get(row.period, -1) > period_order[period] or row.minute > minute
            for row in existing_events
        ):
            raise CupError("An omitted event can only be added after all recorded match events. Undo later dependent actions first.")
    elif period != match.clock.get("period"):
        raise CupError("The event period must match the current match clock period.", 400)
    if type(team_id) is not int or team_id not in {match.home_team_id, match.away_team_id}:
        raise CupError("team_id must be a participating team.", 400)
    if type(player_id) is not int:
        raise CupError("player_id must be an integer.", 400)
    participant = db.session.scalar(select(CupParticipation).where(
        CupParticipation.match_id == match.id,
        CupParticipation.player_id == player_id,
        CupParticipation.team_id == team_id,
    ))
    if participant is None or participant.status not in {"starter", "entered"}:
        raise CupError("The player is not currently eligible to participate.")
    assist_id = data.get("assist_player_id")
    goalkeeper_id = data.get("goalkeeper_id")
    replacement_goalkeeper_id = data.get("replacement_goalkeeper_id")
    outcome = data.get("outcome")
    payload = {}
    changed_participation = []
    if event_type == "shot":
        if outcome not in SHOT_OUTCOMES:
            raise CupError("Shot outcome must be goal, saved, off_target or blocked.", 400)
        if assist_id is not None:
            if type(assist_id) is not int or assist_id == player_id or outcome != "goal":
                raise CupError("An assist is only valid on a goal and cannot credit the scorer.", 400)
            assistant = db.session.scalar(select(CupParticipation).where(
                CupParticipation.match_id == match.id,
                CupParticipation.player_id == assist_id,
                CupParticipation.team_id == team_id,
            ))
            if assistant is None or assistant.status not in {"starter", "entered"}:
                raise CupError("The assist must come from an eligible teammate.")
        if outcome == "saved":
            keeper = db.session.scalar(select(CupParticipation).where(
                CupParticipation.match_id == match.id,
                CupParticipation.player_id == goalkeeper_id,
                CupParticipation.team_id != team_id,
                CupParticipation.goalkeeper.is_(True),
                CupParticipation.status.in_(["starter", "entered"]),
            ))
            if keeper is None:
                raise CupError("A save must name the opposing active goalkeeper.")
        elif goalkeeper_id is not None:
            raise CupError("Only saved shots may name a goalkeeper.", 400)
    elif event_type == "own_goal":
        if assist_id is not None or goalkeeper_id is not None or outcome is not None:
            raise CupError("Own goals do not accept assist, keeper or shot outcome fields.", 400)
    elif event_type in {"yellow_card", "red_card"}:
        if assist_id is not None or goalkeeper_id is not None or outcome is not None:
            raise CupError("Card events do not accept shot fields.", 400)
        second_yellow_dismissal = event_type == "yellow_card" and db.session.scalar(
            select(CupMatchEvent.id).where(
                CupMatchEvent.match_id == match.id, CupMatchEvent.player_id == player_id,
                CupMatchEvent.event_type == "yellow_card", CupMatchEvent.voided.is_(False),
            ).limit(1)
        ) is not None
        dismissal = event_type == "red_card" or second_yellow_dismissal
        if dismissal:
            if participant.goalkeeper:
                if type(replacement_goalkeeper_id) is not int or replacement_goalkeeper_id == player_id:
                    raise CupError("Choose a different active teammate to replace the dismissed goalkeeper.", 400)
                replacement = db.session.scalar(select(CupParticipation).where(
                    CupParticipation.match_id == match.id,
                    CupParticipation.player_id == replacement_goalkeeper_id,
                    CupParticipation.team_id == team_id,
                    CupParticipation.status.in_(["starter", "entered"]),
                ))
                if replacement is None:
                    raise CupError("The replacement goalkeeper must be an active teammate.")
                team_participants = db.session.scalars(select(CupParticipation).where(
                    CupParticipation.match_id == match.id,
                    CupParticipation.team_id == team_id,
                )).all()
                changed_participation.extend(
                    {**_participation_snapshot(row), "match_id": match.id}
                    for row in team_participants
                )
                for row in team_participants:
                    row.goalkeeper = row.player_id == replacement_goalkeeper_id
                payload["replacement_goalkeeper_id"] = replacement_goalkeeper_id
            else:
                if replacement_goalkeeper_id is not None:
                    raise CupError("A replacement goalkeeper is only needed when dismissing the active goalkeeper.", 400)
                changed_participation.append({
                    **_participation_snapshot(participant), "match_id": match.id,
                })
            if second_yellow_dismissal:
                payload["second_yellow_dismissal"] = True
            participant.status = "dismissed"
            participant.left_minute = minute
        elif replacement_goalkeeper_id is not None:
            raise CupError("A replacement goalkeeper is only used for a dismissal.", 400)
    elif event_type == "substitution":
        incoming_id = data.get("incoming_player_id")
        incoming = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match.id,
            CupParticipation.player_id == incoming_id,
            CupParticipation.team_id == team_id,
        ))
        if incoming is None or incoming.status not in {"bench", "substituted"}:
            raise CupError("The substitute must be an eligible player on the bench.")
        changed_participation.extend([
            {
                "match_id": match.id, "player_id": participant.player_id,
                "status": participant.status, "entered_minute": participant.entered_minute,
                "left_minute": participant.left_minute, "goalkeeper": participant.goalkeeper,
            },
            {
                "match_id": match.id, "player_id": incoming.player_id,
                "status": incoming.status, "entered_minute": incoming.entered_minute,
                "left_minute": incoming.left_minute, "goalkeeper": incoming.goalkeeper,
            },
        ])
        participant.status = "substituted"
        participant.left_minute = minute
        incoming.status = "entered"
        incoming.entered_minute = minute
        incoming.goalkeeper = participant.goalkeeper
        participant.goalkeeper = False
    else:
        raise CupError("Unsupported match event type.", 400)
    if event_type == "substitution":
        payload["incoming_player_id"] = incoming_id
    old_score = match_score([_event_dict(row) for row in _events_for_match(match.id)],
                            match.home_team_id, match.away_team_id)
    event = CupMatchEvent(
        match_id=match.id, request_id=request_id, event_type=event_type,
        minute=minute, period=period, team_id=team_id, player_id=player_id,
        assist_player_id=assist_id, goalkeeper_id=goalkeeper_id, outcome=outcome,
        payload=payload, voided=False, created_at=_now(),
    )
    db.session.add(event)
    db.session.flush()
    new_score = match_score([_event_dict(row) for row in _events_for_match(match.id)],
                            match.home_team_id, match.away_team_id)
    score_changed = old_score != new_score
    before_resolutions = deepcopy(tournament.settings.get("tie_resolutions", []))
    if historical and score_changed and match.stage == "league":
        dependent = db.session.scalar(select(CupMatch.id).where(
            CupMatch.tournament_id == tournament.id, CupMatch.stage != "league",
            CupMatch.state != "archived",
        ).limit(1))
        if dependent is not None:
            raise CupError("Undo the dependent playoff qualification before changing a league result.")
        tournament.settings = {**tournament.settings, "tie_resolutions": []}
    if historical and score_changed and match.stage != "league" and match.state == "finalized" and (
        new_score[match.home_team_id] == new_score[match.away_team_id]
    ):
        raise CupError("A finalized tied playoff needs a completed shootout; reopen the result first.")
    match.version += 1
    inverse = {"type": "event", "event_id": event.id, "voided": True, "participation": changed_participation}
    after = {"type": "event", "event_id": event.id, "voided": False, "participation": []}
    if historical and score_changed and match.stage == "league":
        inverse.update(tournament_id=tournament.id, tie_resolutions=before_resolutions)
        after.update(tournament_id=tournament.id, tie_resolutions=[])
    result = _record(
        tournament, request_id, "match_event", expected,
        inverse, after,
        {"match_id": match.id, "event_id": event.id, "event_type": event_type, "historical": historical},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version, "event_id": event.id, "minute": minute})


def _event_audit(match, event):
    rows = _audit_rows(match.tournament_id)
    original = next((row for row in rows if row.match_id == match.id and row.action in {
        "match_event", "shootout_attempt"
    } and row.details.get("event_id") == event.id and row.undone_by_id is None), None)
    if original is None:
        raise CupError("The event's original participation history is unavailable.")
    return original, rows


def _participation_at_event(match, event):
    original, rows = _event_audit(match, event)
    participants = {row["player_id"]: row for row in _lineup_snapshot(match.id)}
    for row in reversed(rows):
        if row.id <= original.id:
            break
        if row.match_id != match.id or row.undone_by_id is not None or row.action == "undo":
            continue
        inverse = row.inverse
        if inverse.get("type") == "lineup":
            participants = {item["player_id"]: dict(item) for item in inverse["rows"]}
        elif inverse.get("type") in {"event", "event_correction"}:
            for item in inverse.get("participation", []):
                if item["player_id"] in participants:
                    participants[item["player_id"]].update(item)
    return participants


def _correct_structural_event(match, event, data):
    original, rows = _event_audit(match, event)
    if any(row.id > original.id and row.match_id == match.id and row.undone_by_id is None
           and row.action in {"match_event", "shootout_attempt", "goalkeeper_change", "match_lineup", "match_bench", "event_correction"}
           for row in rows):
        raise CupError("Later match events depend on this card or substitution. Undo those later match actions before correcting it.")
    participants = db.session.scalars(select(CupParticipation).where(
        CupParticipation.match_id == match.id
    )).all()
    before = [_participation_snapshot(row) for row in participants]
    by_id = {row.player_id: row for row in participants}
    for saved in original.inverse.get("participation", []):
        row = by_id.get(saved["player_id"])
        if row is None:
            raise CupError("The original participation history is unavailable.")
        for field in ("status", "goalkeeper", "entered_minute", "left_minute"):
            setattr(row, field, saved[field])
    if data.get("voided", False):
        event.voided = True
        return before
    team_id, player_id = data.get("team_id"), data.get("player_id")
    participant = by_id.get(player_id) if type(player_id) is int else None
    if type(team_id) is not int or team_id not in {match.home_team_id, match.away_team_id} or (
        participant is None or participant.team_id != team_id or participant.status not in {"starter", "entered"}
    ):
        raise CupError("Choose a player who was active for that team at the event.")
    corrected_type = data.get("event_type")
    if event.event_type == "substitution":
        if corrected_type != "substitution":
            raise CupError("A substitution can only be corrected as a substitution.", 400)
        incoming_id = data.get("incoming_player_id")
        incoming = by_id.get(incoming_id) if type(incoming_id) is int else None
        if incoming is None or incoming.team_id != team_id or incoming.status not in {"bench", "substituted"}:
            raise CupError("The incoming player must have been on that team's bench.")
        participant.status = "substituted"
        participant.left_minute = event.minute
        incoming.status = "entered"
        incoming.entered_minute = event.minute
        incoming.goalkeeper = participant.goalkeeper
        participant.goalkeeper = False
        payload = {"incoming_player_id": incoming_id}
    else:
        if corrected_type not in {"yellow_card", "red_card"}:
            raise CupError("A card can only be corrected to yellow or red.", 400)
        prior_yellow = db.session.scalar(select(CupMatchEvent.id).where(
            CupMatchEvent.match_id == match.id, CupMatchEvent.id != event.id,
            CupMatchEvent.player_id == player_id, CupMatchEvent.event_type == "yellow_card",
            CupMatchEvent.voided.is_(False),
        ).limit(1)) is not None
        second_yellow = corrected_type == "yellow_card" and prior_yellow
        dismissal = corrected_type == "red_card" or second_yellow
        replacement_id = data.get("replacement_goalkeeper_id")
        payload = {"second_yellow_dismissal": True} if second_yellow else {}
        if dismissal:
            if participant.goalkeeper:
                replacement = by_id.get(replacement_id) if type(replacement_id) is int else None
                if replacement is None or replacement.player_id == player_id or replacement.team_id != team_id or (
                    replacement.status not in {"starter", "entered"}
                ):
                    raise CupError("Choose a different active teammate to replace the dismissed goalkeeper.")
                for row in participants:
                    if row.team_id == team_id:
                        row.goalkeeper = row.player_id == replacement_id
                payload["replacement_goalkeeper_id"] = replacement_id
            elif replacement_id is not None:
                raise CupError("A replacement goalkeeper is only needed for a dismissed goalkeeper.", 400)
            participant.status = "dismissed"
            participant.left_minute = event.minute
        elif replacement_id is not None:
            raise CupError("A replacement goalkeeper is only used for a dismissal.", 400)
    event.team_id, event.player_id, event.event_type = team_id, player_id, corrected_type
    event.payload = payload
    return before


@cup_api.post("/host/matches/<int:match_id>/events/<int:event_id>/correct")
@host_required
def correct_match_event(match_id, event_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("event_correction")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "event_correction", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    if match.version != _expected_version(data, "expected_match_version"):
        raise CupError("This match changed in another tab. Refresh before correcting it.")
    if match.settings.get("shootout_finish"):
        raise CupError("Undo the host's shootout finish and its dependent actions before correcting match events.")
    if match.state not in {"live", "paused", "review", "finalized"}:
        raise CupError("Only a played match can be corrected.")
    if match.state == "finalized" and data.get("confirm_finalized") is not True:
        raise CupError("Confirm that this finalized result should be corrected.", 400)
    event = db.session.get(CupMatchEvent, event_id)
    if event is None or event.match_id != match.id or event.voided:
        raise CupError("The active match event was not found.", 404)
    if event.event_type not in {"shot", "own_goal", "shootout", "yellow_card", "red_card", "substitution"}:
        raise CupError("This event type cannot be corrected.")
    participants = _participation_at_event(match, event)
    fields = ("event_type", "minute", "team_id", "player_id", "assist_player_id", "goalkeeper_id", "outcome", "payload", "voided")
    before_values = {field: deepcopy(getattr(event, field)) for field in fields}
    old_score = match_score([_event_dict(row) for row in _events_for_match(match.id)],
                            match.home_team_id, match.away_team_id)
    old_shootout_winner = _shootout_result(match, _events_for_match(match.id))[0]
    voided = data.get("voided", False)
    if type(voided) is not bool:
        raise CupError("voided must be true or false.", 400)
    if event.event_type != "shootout":
        minute = data.get("minute", event.minute)
        if type(minute) is not int or not 0 <= minute <= 300:
            raise CupError("minute must be between 0 and 300.", 400)
        if minute != event.minute:
            lower, upper = sorted((minute, event.minute))
            structural = {"yellow_card", "red_card", "substitution"}
            if any(row.id != event.id and (event.event_type in structural or row.event_type in structural)
                   and lower <= row.minute <= upper for row in _events_for_match(match.id)):
                raise CupError("Changing this minute would cross a dependent match event; undo dependent actions first.")
            if any(row.match_id == match.id and row.action == "goalkeeper_change" and row.undone_by_id is None
                   for row in _audit_rows(tournament.id)):
                raise CupError("Goalkeeper changes have no recorded minute; undo them before changing an event minute.")
            event.minute = minute
    participation_before = None
    if event.event_type in {"yellow_card", "red_card", "substitution"}:
        participation_before = _correct_structural_event(match, event, data)
    elif event.event_type == "shootout":
        scored = data.get("scored")
        if type(scored) is not bool or voided:
            raise CupError("A shootout correction must specify scored or missed.", 400)
        event.payload = {**event.payload, "scored": scored}
    elif not voided:
        team_id, player_id = data.get("team_id"), data.get("player_id")
        player = participants.get(player_id) if type(player_id) is int else None
        if type(team_id) is not int or team_id not in {match.home_team_id, match.away_team_id}:
            raise CupError("Choose a participating team.", 400)
        if not player or player.get("team_id") != team_id or player.get("status") not in {"starter", "entered"}:
            raise CupError("The player was not active for that team when the event was recorded.")
        event.team_id, event.player_id = team_id, player_id
        if event.event_type == "shot":
            outcome, assist_id, keeper_id = data.get("outcome"), data.get("assist_player_id"), data.get("goalkeeper_id")
            if outcome not in SHOT_OUTCOMES:
                raise CupError("Choose a valid shot outcome.", 400)
            if assist_id is not None:
                assistant = participants.get(assist_id) if type(assist_id) is int else None
                if outcome != "goal" or assist_id == player_id or not assistant or (
                    assistant.get("team_id") != team_id or assistant.get("status") not in {"starter", "entered"}
                ):
                    raise CupError("The assist must be an active teammate other than the scorer.", 400)
            if outcome == "saved":
                keeper = participants.get(keeper_id) if type(keeper_id) is int else None
                if not keeper or keeper.get("team_id") == team_id or not keeper.get("goalkeeper") or (
                    keeper.get("status") not in {"starter", "entered"}
                ):
                    raise CupError("The save must credit the opposing active goalkeeper.", 400)
            elif keeper_id is not None:
                raise CupError("Only a saved shot may credit a goalkeeper.", 400)
            event.outcome, event.assist_player_id, event.goalkeeper_id = outcome, assist_id, keeper_id
    event.voided = voided
    db.session.flush()
    events = _events_for_match(match.id)
    new_score = match_score([_event_dict(row) for row in events], match.home_team_id, match.away_team_id)
    score_changed = old_score != new_score
    if match.stage == "league" and match.clock.get("period") == "shootout":
        # A league shootout decides points, so its winner counts as a result change.
        score_changed = score_changed or old_shootout_winner != _shootout_result(match, events)[0]
    if score_changed and match.stage == "league":
        dependent = db.session.scalar(select(CupMatch.id).where(
            CupMatch.tournament_id == tournament.id, CupMatch.stage != "league",
            CupMatch.state != "archived",
        ).limit(1))
        if dependent is not None:
            raise CupError("Undo the dependent playoff qualification before changing a league result.")
    if match.stage != "league" or match.clock.get("period") == "shootout":
        attempts = sorted((row for row in events if row.event_type == "shootout"), key=lambda row: row.id)
        if attempts and new_score[match.home_team_id] != new_score[match.away_team_id]:
            raise CupError("The recorded shootout requires a tied match score.")
        for index in range(1, len(attempts)):
            if _shootout_result(match, attempts[:index])[0] is not None:
                raise CupError("This correction would make a later shootout attempt invalid.")
        if match.state == "finalized" and new_score[match.home_team_id] == new_score[match.away_team_id]:
            if _shootout_result(match, attempts)[0] is None:
                raise CupError("A finalized tied playoff or league shootout requires a completed shootout.")
    old_resolutions = deepcopy(tournament.settings.get("tie_resolutions", []))
    if score_changed and match.stage == "league":
        tournament.settings = {**tournament.settings, "tie_resolutions": []}
    match.version += 1
    before = {"type": "event_correction", "event_id": event.id, "values": before_values}
    after = {"type": "event_correction", "event_id": event.id,
             "values": {field: deepcopy(getattr(event, field)) for field in fields}}
    if participation_before is not None:
        before["participation"] = participation_before
        after["participation"] = _lineup_snapshot(match.id)
    if score_changed and match.stage == "league":
        before.update(tournament_id=tournament.id, tie_resolutions=old_resolutions)
        after.update(tournament_id=tournament.id, tie_resolutions=[])
    result = _record(tournament, request_id, "event_correction", expected, before, after,
                     {"match_id": match.id, "event_id": event.id}, match_id=match.id)
    db.session.commit()
    return jsonify({**result, "match_version": match.version})


@cup_api.post("/host/matches/<int:match_id>/finalize")
@host_required
def finalize_match(match_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("match_finalize")
    if previous is not None:
        return jsonify(previous)
    match, tournament = _locked_match_and_tournament(match_id)
    previous = _recheck_after_lock(request_id, "match_finalize", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    expected_match = _expected_version(data, "expected_match_version")
    _require_version(tournament, expected)
    if match.version != expected_match:
        raise CupError("This match changed in another tab. Refresh before finalizing.")
    if match.state != "review":
        raise CupError("End the match clock and review the score before finalizing.")
    if match.stage != "league" or match.clock.get("period") == "shootout":
        score = match_score(
            [_event_dict(event) for event in _events_for_match(match.id)],
            match.home_team_id, match.away_team_id,
        )
        if score[match.home_team_id] == score[match.away_team_id]:
            winner, _, _, _, _ = _shootout_result(match, _events_for_match(match.id))
            if winner is None:
                raise CupError(
                    "A tied playoff needs a completed penalty shootout before finalization."
                    if match.stage != "league" else
                    "Complete the penalty shootout, or return to a draw, before finalizing this league match."
                )
    previous_state, previous_time = match.state, match.finalized_at
    previous_lifecycle = tournament.lifecycle
    match.state = "finalized"
    reopened_at = match.settings.get("reopened_finalized_at") if match.stage == "league" else None
    match.finalized_at = _as_utc(datetime.fromisoformat(reopened_at)) if reopened_at else _now()
    match.version += 1
    result = _record(
        tournament, request_id, "match_finalize", expected,
        {"type": "match_finalization", "match_id": match.id, "tournament_id": tournament.id,
         "state": previous_state, "lifecycle": previous_lifecycle,
         "finalized_at": previous_time.isoformat() if previous_time else None},
        {"type": "match_finalization", "match_id": match.id, "tournament_id": tournament.id,
         "state": "finalized", "lifecycle": tournament.lifecycle,
         "finalized_at": match.finalized_at.isoformat()},
        {"match_id": match.id},
        match_id=match.id,
    )
    db.session.commit()
    return jsonify({**result, "match_version": match.version})


@cup_api.get("/host/<int:tournament_id>/history")
@host_required
def host_history(tournament_id):
    _tournament(tournament_id, include_archived=True)
    rows = _audit_rows(tournament_id)
    return jsonify(history=[
        {
            "id": row.id, "action": row.action, "match_id": row.match_id,
            "created_at": row.created_at.isoformat(), "details": {
                key: value for key, value in row.details.items() if key != "response"
            },
            "undone": row.undone_by_id is not None,
        }
        for row in rows
    ])


@cup_api.get("/host/<int:tournament_id>/undo-preview")
@host_required
def undo_preview(tournament_id):
    tournament = _tournament(tournament_id, include_archived=True)
    rows = _audit_rows(tournament.id)
    target_id = request.args.get("target_audit_id", type=int)
    if target_id is None:
        target = next((
            row for row in reversed(rows)
            if row.undone_by_id is None and row.action != "undo"
        ), None)
    else:
        target = next((row for row in rows if row.id == target_id), None)
        if target is not None and (target.undone_by_id is not None or target.action == "undo"):
            target = None
    if target is None:
        return jsonify(target=None, affected=[])
    affected = [
        row for row in rows
        if row.id > target.id and row.undone_by_id is None and row.action != "undo"
    ]
    _check_profile_undo_is_isolated(tournament.id, [target, *affected])
    return jsonify(
        target={"id": target.id, "action": target.action, "match_id": target.match_id},
        affected=[{"id": row.id, "action": row.action, "match_id": row.match_id} for row in affected],
        expected_version=tournament.version,
    )


@cup_api.post("/host/<int:tournament_id>/undo")
@host_required
def undo_last_action(tournament_id):
    csrf_response = _require_csrf()
    if csrf_response is not None:
        return csrf_response
    data, request_id, previous = _mutating_request("undo")
    if previous is not None:
        return jsonify(previous)
    tournament = _tournament(tournament_id, lock=True, include_archived=True)
    previous = _recheck_after_lock(request_id, "undo", data)
    if previous is not None:
        return jsonify(previous)
    expected = _expected_version(data)
    _require_version(tournament, expected)
    _lock_cup_identities()
    rows = _audit_rows(tournament.id)
    target_id = data.get("target_audit_id")
    if type(target_id) is not int:
        raise CupError("target_audit_id must identify the action being undone.", 400)
    target = next((row for row in rows if row.id == target_id), None)
    if target is None or target.undone_by_id is not None:
        raise CupError("That action is already undone or is not in this tournament's history.")
    if target.action == "undo":
        raise CupError("Undo records are preserved but cannot themselves be undone.", 409)
    targets = [
        row for row in rows
        if row.id >= target_id and row.undone_by_id is None and row.action != "undo"
    ]
    affected = [row for row in targets if row.id != target_id]
    if affected and data.get("cascade") is not True:
        raise CupError("Later host actions depend on this state. Review the undo preview and confirm cascade.", 409)
    _check_profile_undo_is_isolated(tournament.id, targets)
    targets = sorted(targets, key=lambda row: row.id, reverse=True)
    try:
        for target in targets:
            _apply_snapshot(target.inverse)
    except (KeyError, TypeError, ValueError) as error:
        raise CupError(f"Undo could not be applied safely: {error}", 409) from None
    result = _record(
        tournament, request_id, "undo", expected,
        {"type": "targets", "tournament_id": tournament.id,
         "ids": [row.id for row in targets], "redo": True},
        {"type": "targets", "tournament_id": tournament.id,
         "ids": [row.id for row in targets], "redo": False},
        {"target_ids": [row.id for row in targets]},
    )
    db.session.flush()
    undo_audit_id = db.session.scalar(select(CupAudit.id).where(CupAudit.request_id == request_id))
    for target in targets:
        target.undone_by_id = undo_audit_id or 0
    db.session.commit()
    return jsonify({**result, "undone_ids": [row.id for row in targets]})


def register_cup(app):
    app.register_blueprint(cup_api)

    @app.errorhandler(CupError)
    def handle_unblueprinted_cup_error(error):
        db.session.rollback()
        return _error(error)
