from copy import deepcopy
from datetime import datetime, timezone
import random

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from auth import check_csrf, host_required
from extensions import db
from models import Auction, AuctionEvent, Player, Team


auction_api = Blueprint("auction", __name__, url_prefix="/api/auction")
POSITIONS = {"GK", "DEF", "MID", "ST"}
SETS = ("GK", "DEF", "MID", "ST", "UNSOLD")
BUDGET = 1000


class RuleError(Exception):
    def __init__(self, message, status=409):
        self.message = message
        self.status = status


def initial_state():
    return {
        "status": "setup", "squad_size": 1, "current": None,
        "sales": {}, "unsold": [], "last_event": None,
        "captains": {}, "open_set": None,
    }


def locked_auction():
    # One transaction-wide lock also serializes profile edits and auction starts.
    if db.engine.dialect.name == "postgresql":
        db.session.execute(text("SELECT pg_advisory_xact_lock(794520261017)"))
        statement = pg_insert(Auction)
    else:
        statement = sqlite_insert(Auction)
    db.session.execute(statement.values(
        id=1, version=0, state=initial_state()
    ).on_conflict_do_nothing(index_elements=["id"]))
    return db.session.execute(
        select(Auction).where(Auction.id == 1).with_for_update()
    ).scalar_one()


def team_totals(state, team_id):
    purchases = [sale for sale in state["sales"].values() if sale["team_id"] == team_id]
    captain = state.get("captains", {}).get(str(team_id))
    spent = sum(sale["price"] for sale in purchases) + (captain["price"] if captain else 0)
    slots = state["squad_size"] - len(purchases) - (1 if captain else 0)
    budget = BUDGET - spent
    maximum = min(budget, budget - 10 * (slots - 1)) if slots > 0 else 0
    return spent, budget, slots, maximum


def captain_ids(state):
    return {c["player_id"]: int(team_id) for team_id, c in state.get("captains", {}).items()}


def set_pool(state, set_name):
    """Player ids the host may bring to the floor from one set."""
    taken = {int(pid) for pid in state["sales"]} | set(captain_ids(state))
    players = db.session.scalars(select(Player).order_by(Player.id)).all()
    if set_name == "UNSOLD":
        return [p.id for p in players if p.id in state["unsold"] and p.id not in taken]
    return [p.id for p in players
            if p.position == set_name and p.id not in taken and p.id not in state["unsold"]]


def snapshot(record=None):
    record = record or db.session.get(Auction, 1)
    state = record.state if record else initial_state()
    players = db.session.scalars(select(Player).order_by(Player.id)).all()
    teams = db.session.scalars(select(Team).order_by(Team.id)).all()
    current = state["current"]
    captains = state.get("captains", {})
    captain_teams = captain_ids(state)
    player_rows = []
    for player in players:
        sale = state["sales"].get(str(player.id))
        captain_team = captain_teams.get(player.id)
        if captain_team is not None:
            sale = {"team_id": captain_team, "price": captains[str(captain_team)]["price"]}
        status = (
            "sold" if sale else
            "current" if current and current["player_id"] == player.id else
            "unsold" if player.id in state["unsold"] else "available"
        )
        player_rows.append({
            "id": player.id, "name": player.name, "photo_path": player.photo_path,
            "position": player.position, "status": status,
            "team_id": sale["team_id"] if sale else None,
            "price": sale["price"] if sale else None,
            "captain": captain_team is not None,
            "bids": sale.get("bids", []) if sale else [],
        })
    team_rows = []
    for team in teams:
        spent, budget, slots, maximum = team_totals(state, team.id)
        team_rows.append({
            "id": team.id, "name": team.name, "logo_path": team.logo_path,
            "spent": spent, "budget": budget, "remaining_slots": slots, "max_bid": maximum,
            "roster": [{
                "id": player["id"], "name": player["name"],
                "photo_path": player["photo_path"], "position": player["position"],
                "price": player["price"], "captain": player["captain"],
            } for player in player_rows if player["team_id"] == team.id],
        })
    latest = latest_reversible()
    return {
        "version": record.version if record else 0,
        "fixed_teams": current_app.config["OFFICIAL_TEAMS"],
        "status": state["status"], "squad_size": state["squad_size"],
        "open_set": state.get("open_set"),
        "current": current, "teams": team_rows, "players": player_rows,
        "last_event": state.get("last_event"),
        "can_undo": latest is not None and latest.after == state,
    }


def latest_reversible():
    return db.session.scalars(select(AuctionEvent).where(
        AuctionEvent.action.not_in(["undo", "profile", "maintenance"]),
        AuctionEvent.undone.is_(False),
    ).order_by(AuctionEvent.id.desc()).limit(1)).first()


def positive_id(data, key):
    value = data.get(key)
    if type(value) is not int or value < 1:
        raise RuleError(f"{key} must be a positive integer.", 400)
    return value


def captain_limit(squad_size):
    return BUDGET - 10 * (squad_size - 1)


def apply_action(state, data):
    action = data["action"]
    state.setdefault("captains", {})
    state.setdefault("open_set", None)
    if action == "configure":
        if state["status"] != "setup":
            raise RuleError("Squad size cannot change after starting.")
        size = positive_id(data, "squad_size")
        if size > 100:
            raise RuleError("Squad size must be between 1 and 100.", 400)
        if any(c["price"] > captain_limit(size) for c in state["captains"].values()):
            raise RuleError(f"A captain price is above {captain_limit(size)} points, the limit for "
                            f"{size} players per team. Lower that captain price first.")
        state["squad_size"] = size
    elif action == "captain":
        if state["status"] != "setup":
            raise RuleError("Captains can only be assigned during setup.")
        team_id = positive_id(data, "team_id")
        player_id = positive_id(data, "player_id")
        price = data.get("price")
        if db.session.get(Team, team_id) is None:
            raise RuleError("Team not found.", 404)
        if db.session.get(Player, player_id) is None:
            raise RuleError("Player not found.", 404)
        if type(price) is not int or price < 10 or price % 10:
            raise RuleError("Captain price must be a multiple of 10, minimum 10.", 400)
        limit = captain_limit(state["squad_size"])
        if price > limit:
            raise RuleError(f"Captain price can be at most {limit} points so 10 points stay "
                            "reserved for every other squad slot.")
        other = captain_ids(state).get(player_id)
        if other is not None and other != team_id:
            raise RuleError("This player is already another team's captain.")
        state["captains"][str(team_id)] = {"player_id": player_id, "price": price}
    elif action == "remove_captain":
        if state["status"] != "setup":
            raise RuleError("Captains can only be changed during setup.")
        team_id = positive_id(data, "team_id")
        if state["captains"].pop(str(team_id), None) is None:
            raise RuleError("This team has no captain to remove.")
    elif action == "start":
        if state["status"] != "setup":
            raise RuleError("Auction has already started.")
        teams = db.session.scalars(select(Team)).all()
        players = db.session.scalars(select(Player)).all()
        if len(teams) != 5:
            raise RuleError("Exactly five teams are required.")
        if current_app.config["OFFICIAL_TEAMS"]:
            from branding import OFFICIAL_TEAMS
            if {team.name: team.logo_path for team in teams} != {
                name: f"/api/branding/{file}" for name, file in OFFICIAL_TEAMS
            }:
                raise RuleError("Prepare the five official teams before starting.")
        if {int(team_id) for team_id in state["captains"]} != {team.id for team in teams}:
            raise RuleError("Assign a captain and captain price for all five teams before starting.")
        if len(players) < 5 * state["squad_size"]:
            raise RuleError(f"At least {5 * state['squad_size']} players are required.")
        from media import valid_media_path
        if any(not valid_media_path(team.logo_path) for team in teams):
            raise RuleError("Upload a valid logo for every team before starting.")
        if any(
            not valid_media_path(player.photo_path) or player.position not in POSITIONS
            for player in players
        ):
            raise RuleError("Every player needs an uploaded photo and GK/DEF/MID/ST position.")
        state["status"] = "running"
        if all(team_totals(state, team.id)[2] == 0 for team in teams):
            state["status"] = "completed"
    elif action == "pause":
        if state["status"] != "running":
            raise RuleError("Only a running auction can be paused.")
        state["status"] = "paused"
    elif action == "resume":
        if state["status"] != "paused":
            raise RuleError("Auction is not paused.")
        state["status"] = "running"
    elif action in {"select", "random", "bid", "sold", "unsold", "reauction", "open_set", "close_set"}:
        if state["status"] != "running":
            raise RuleError("Auction must be running for this action.")
        current = state["current"]
        if action == "open_set":
            if current:
                raise RuleError("Sell, mark unsold, or undo the current player before switching sets.")
            set_name = data.get("set_name")
            if set_name not in SETS:
                raise RuleError("Choose the GK, DEF, MID, ST or UNSOLD set.", 400)
            if state["open_set"] == set_name:
                raise RuleError("This set is already open.")
            state["open_set"] = set_name
        elif action == "close_set":
            if current:
                raise RuleError("Sell, mark unsold, or undo the current player before closing the set.")
            if state["open_set"] is None:
                raise RuleError("No set is open.")
            state["open_set"] = None
        elif action in {"select", "random"}:
            if current:
                raise RuleError("Sell, mark unsold, or undo the current selection first.")
            if state["open_set"] is None:
                raise RuleError("Open a set first (GK, DEF, MID, ST or Unsold).")
            eligible = set_pool(state, state["open_set"])
            if action == "random":
                if not eligible:
                    raise RuleError("No players remain in this set.")
                pid = random.SystemRandom().choice(eligible)
            else:
                pid = positive_id(data, "player_id")
                if pid not in eligible:
                    raise RuleError("That player is not waiting in the open set.")
            state["unsold"] = [item for item in state["unsold"] if item != pid]
            state["current"] = {"player_id": pid, "team_id": None, "bid": 0, "bids": []}
        elif action == "reauction":
            pid = positive_id(data, "player_id")
            if pid not in state["unsold"]:
                raise RuleError("Only an unsold player can be re-listed.")
            state["unsold"].remove(pid)
        else:
            if current is None:
                raise RuleError("Select a player first.")
            if action == "bid":
                team_id = positive_id(data, "team_id")
                if db.session.get(Team, team_id) is None:
                    raise RuleError("Team not found.", 404)
                if current["team_id"] == team_id:
                    raise RuleError("The leading team cannot bid against itself.")
                next_bid = current["bid"] + 10
                _, _, slots, maximum = team_totals(state, team_id)
                if slots <= 0:
                    raise RuleError("This team's squad is full.")
                if next_bid > maximum:
                    raise RuleError("Bid exceeds the budget after reserving 10 per unfilled slot.")
                current["team_id"] = team_id
                current["bid"] = next_bid
                current.setdefault("bids", []).append({"team_id": team_id, "amount": next_bid})
            elif action == "sold":
                if current["team_id"] is None or current["bid"] < 10:
                    raise RuleError("A valid opening bid is required before selling.")
                _, _, slots, maximum = team_totals(state, current["team_id"])
                if slots <= 0 or current["bid"] > maximum:
                    raise RuleError("Team budget or squad capacity changed; cannot sell.")
                state["sales"][str(current["player_id"])] = {
                    "team_id": current["team_id"], "price": current["bid"],
                    "bids": current.get("bids", []),
                }
                state["current"] = None
                teams = db.session.scalars(select(Team)).all()
                if all(team_totals(state, team.id)[2] == 0 for team in teams):
                    state["status"] = "completed"
            elif action == "unsold":
                state["unsold"].append(current["player_id"])
                state["current"] = None
    else:
        raise RuleError("Unknown auction action.", 400)


@auction_api.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@auction_api.errorhandler(RuleError)
def rule_error(error):
    db.session.rollback()
    return jsonify(error=error.message), error.status


@auction_api.get("/state")
def public_state():
    if "sqlalchemy" not in current_app.extensions:
        return jsonify(error="Auction database is not configured."), 503
    return jsonify(snapshot())


@auction_api.get("/host-state")
@auction_api.get("/display-state")
@host_required
def private_state():
    return jsonify(snapshot())


@auction_api.get("/history")
@host_required
def history():
    events = db.session.scalars(select(AuctionEvent).order_by(AuctionEvent.id.desc())).all()
    return jsonify(events=[{
        "id": event.id, "action": event.action,
        "created_at": event.created_at.isoformat(), "undone": event.undone,
        "summary": event.after.get("last_event"),
    } for event in events])


@auction_api.get("/backup")
@host_required
def download_backup():
    """Host-only: download the full auction (state, profiles, history) as a JSON file."""
    import json

    record = db.session.get(Auction, 1)
    events = db.session.scalars(select(AuctionEvent).order_by(AuctionEvent.id)).all()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    body = json.dumps({
        "kind": "venomsfc-auction-backup", "created_at": datetime.now(timezone.utc).isoformat(),
        "version": record.version if record else 0,
        "state": record.state if record else initial_state(),
        "snapshot": snapshot(record),
        "events": [{"id": e.id, "action": e.action, "payload": e.payload, "before": e.before,
                    "after": e.after, "version": e.version, "undone": e.undone,
                    "created_at": e.created_at.isoformat()} for e in events],
    }, indent=2)
    response = current_app.response_class(body, mimetype="application/json")
    response.headers["Content-Disposition"] = f'attachment; filename="venomsfc-auction-backup-{stamp}.json"'
    return response


@auction_api.post("/actions")
@host_required
def mutate():
    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise RuleError("Provide a JSON object.", 400)
    action = data.get("action")
    fields = {
        "configure": {"squad_size"}, "start": set(), "select": {"player_id"},
        "captain": {"team_id", "player_id", "price"}, "remove_captain": {"team_id"},
        "open_set": {"set_name"}, "close_set": set(),
        "random": set(), "bid": {"team_id"}, "sold": set(), "unsold": set(),
        "pause": set(), "resume": set(), "undo": set(), "reauction": {"player_id"},
    }
    if not isinstance(action, str) or action not in fields:
        raise RuleError("Unknown auction action.", 400)
    if set(data) != {"action", "request_id", "expected_version"} | fields[action]:
        raise RuleError("Unexpected or missing action fields.", 400)
    request_id = data.get("request_id")
    if (
        not isinstance(request_id, str) or not 8 <= len(request_id) <= 64
        or not request_id.isascii()
        or not all(c.isalnum() or c in "-_" for c in request_id)
    ):
        raise RuleError("request_id must be an 8-64 character unique identifier.", 400)
    if type(data.get("expected_version")) is not int or data["expected_version"] < 0:
        raise RuleError("expected_version must be a nonnegative integer.", 400)
    record = locked_auction()
    previous = db.session.scalar(select(AuctionEvent).where(
        AuctionEvent.request_id == request_id
    ))
    if previous:
        if previous.payload != data:
            raise RuleError("This request ID was already used with different input.")
        result = snapshot(record)
        db.session.commit()
        return jsonify(result)
    if record.version != data["expected_version"]:
        raise RuleError("Auction changed in another window. Refresh and retry.")
    before = deepcopy(record.state)
    state = deepcopy(before)
    if action == "undo":
        target = latest_reversible()
        if target is None:
            raise RuleError("There is no action to undo.")
        if target.after != before:
            raise RuleError("Newer setup changes prevent this undo. No state was overwritten.")
        state = deepcopy(target.before)
        target.undone = True
    else:
        apply_action(state, data)
        summary = {"action": action}
        if before["current"]:
            summary.update(before["current"])
            summary["amount"] = before["current"]["bid"]
        if action in {"select", "random", "bid"}:
            summary.update(state["current"])
            summary["amount"] = state["current"]["bid"]
        if action == "reauction":
            summary["player_id"] = data["player_id"]
        if action in {"captain", "remove_captain"}:
            summary = {"action": action, "team_id": data["team_id"]}
            if action == "captain":
                summary.update(player_id=data["player_id"], amount=data["price"])
        if action in {"open_set", "close_set"}:
            summary["set_name"] = data.get("set_name", before.get("open_set"))
        summary.pop("bids", None)
        state["last_event"] = summary
    record.state = state
    record.version += 1
    db.session.add(AuctionEvent(
        request_id=request_id, payload=data, action=action, before=before,
        after=deepcopy(state), version=record.version, undone=False,
        created_at=datetime.now(timezone.utc),
    ))
    db.session.flush()
    result = snapshot(record)
    db.session.commit()
    return jsonify(result)


def write_backup(record, before, label):
    import json
    from pathlib import Path

    events = db.session.scalars(select(AuctionEvent).order_by(AuctionEvent.id)).all()
    folder = Path(current_app.config.get("BACKUP_FOLDER") or Path(current_app.root_path) / "backups")
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = folder / f"auction-before-{label}-{stamp}.json"
    backup.write_text(json.dumps({
        "version": record.version, "state": before,
        "events": [{"id": e.id, "action": e.action, "payload": e.payload, "before": e.before,
                    "after": e.after, "version": e.version, "undone": e.undone,
                    "created_at": e.created_at.isoformat()} for e in events],
    }, indent=2), encoding="utf-8")
    return backup


@auction_api.post("/delete-auction")
@host_required
def delete_auction():
    """Host-only: back up, then wipe a started auction while keeping profiles, squad size and captains."""
    import secrets

    csrf_error = check_csrf()
    if csrf_error:
        return csrf_error
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or set(data) != {"confirm", "expected_version"}:
        raise RuleError("Unexpected or missing fields.", 400)
    if data["confirm"] != "DELETE":
        raise RuleError("Type DELETE to confirm.", 400)
    if type(data["expected_version"]) is not int or data["expected_version"] < 0:
        raise RuleError("expected_version must be a nonnegative integer.", 400)
    record = locked_auction()
    if record.version != data["expected_version"]:
        raise RuleError("Auction changed in another window. Refresh and retry.")
    before = deepcopy(record.state)
    if before["status"] == "setup":
        raise RuleError("The auction has not started. Nothing to delete.")
    backup = write_backup(record, before, "delete-auction")
    removed = db.session.query(AuctionEvent).delete(synchronize_session=False)
    state = initial_state()
    state["squad_size"] = before["squad_size"]
    state["captains"] = before.get("captains", {})
    state["last_event"] = {"action": "maintenance", "operation": "delete_auction"}
    record.state = state
    record.version += 1
    db.session.add(AuctionEvent(
        request_id=secrets.token_hex(24),
        payload={"maintenance": "delete_auction", "backup": backup.name, "events_removed": removed},
        action="maintenance", before=before, after=deepcopy(state), version=record.version,
        undone=False, created_at=datetime.now(timezone.utc),
    ))
    db.session.flush()
    result = snapshot(record)
    db.session.commit()
    return jsonify(result)


def register_maintenance(app):
    import secrets

    import click

    @app.cli.command("reset-auction")
    @click.confirmation_option(prompt="Erase ALL auction progress (sales, bids, unsold list, sets, captains, "
                                      "squad size and action history)? Players, teams, logos, photos and the "
                                      "host password are kept. A JSON backup is written first.")
    def reset_auction():
        """Back up, then clear all auction progress, captains, squad size and history."""
        record = locked_auction()
        before = deepcopy(record.state)
        backup = write_backup(record, before, "reset")
        removed = db.session.query(AuctionEvent).delete(synchronize_session=False)
        state = initial_state()
        state["last_event"] = {"action": "maintenance", "operation": "reset"}
        record.state = state
        record.version += 1
        db.session.add(AuctionEvent(
            request_id=secrets.token_hex(24),
            payload={"maintenance": "reset", "backup": backup.name, "events_removed": removed},
            action="maintenance", before=before, after=deepcopy(state), version=record.version,
            undone=False, created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        click.echo(f"Auction reset to a fresh setup (version {record.version}); {removed} history "
                   f"entries cleared. Backup: {backup}")

    @app.cli.command("return-to-setup")
    @click.confirmation_option(prompt="Return the auction to setup? Only allowed while no player is sold. "
                                      "Profiles, photos, squad size and captains are kept.")
    def return_to_setup():
        """Clear test selections/bids and reopen setup; refuses after any sale."""
        record = locked_auction()
        before = deepcopy(record.state)
        if before["status"] == "setup":
            db.session.rollback()
            raise click.ClickException("The auction is already in setup. Nothing changed.")
        if before.get("sales"):
            db.session.rollback()
            raise click.ClickException("Players have already been sold. Use host Undo instead. Nothing changed.")
        backup = write_backup(record, before, "return-to-setup")
        state = initial_state()
        state["squad_size"] = before["squad_size"]
        state["captains"] = before.get("captains", {})
        state["last_event"] = {"action": "maintenance", "operation": "return_to_setup"}
        record.state = state
        record.version += 1
        db.session.add(AuctionEvent(
            request_id=secrets.token_hex(24), payload={"maintenance": "return_to_setup"},
            action="maintenance", before=before, after=deepcopy(state), version=record.version,
            undone=False, created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        click.echo(f"Auction returned to setup (version {record.version}). Backup: {backup}")
