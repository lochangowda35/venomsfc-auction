from pathlib import Path

import click
from flask import Blueprint, current_app, jsonify, send_from_directory
from sqlalchemy import select

from auction import locked_auction
from extensions import db
from models import Team


branding = Blueprint("branding", __name__, url_prefix="/api/branding")
BRANDING_FOLDER = Path(__file__).parent / "assets" / "branding"
OFFICIAL_TEAMS = (
    ("BlackMambas", "blackmambas.jpg"),
    ("Cobras", "cobras.jpg"),
    ("Vipers", "vipers.jpg"),
    ("Pythons", "pythons.jpg"),
    ("Anacondas", "anacondas.jpg"),
)
ASSETS = {
    "venoms-fc.jpg", "auction-banner.jpg", "blackmambas-crest.jpg", "vipers-crest.jpg",
} | {file for _, file in OFFICIAL_TEAMS}
TEAM_LOGOS = {f"/api/branding/{file}" for _, file in OFFICIAL_TEAMS}


@branding.get("/<name>")
def official_asset(name):
    if name not in ASSETS:
        return jsonify(error="Official image not found."), 404
    response = send_from_directory(BRANDING_FOLDER, name)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


def prepare_official_teams():
    """Install fixed identities without replacing existing unrelated records."""
    record = locked_auction()
    teams = db.session.scalars(select(Team).order_by(Team.id)).all()
    expected = {name: f"/api/branding/{file}" for name, file in OFFICIAL_TEAMS}
    if record.state["status"] != "setup":
        if len(teams) == 5 and {team.name: team.logo_path for team in teams} == expected:
            db.session.commit()
            return False
        db.session.rollback()
        raise click.ClickException("An auction is in progress. Official teams were not changed.")
    if teams and (len(teams) != 5 or {team.name for team in teams} != set(expected)):
        db.session.rollback()
        raise click.ClickException(
            "Existing teams do not match the official five. No records were replaced. "
            "Review the existing data before applying official presets."
        )
    changed = False
    if not teams:
        for name, file in OFFICIAL_TEAMS:
            db.session.add(Team(name=name, logo_path=f"/api/branding/{file}"))
        changed = True
    else:
        for team in teams:
            if team.logo_path != expected[team.name]:
                team.logo_path = expected[team.name]
                changed = True
    if changed:
        from profiles import profile_changed
        profile_changed(record, "official teams", "preset")
    db.session.commit()
    return changed


def register_branding(app):
    app.register_blueprint(branding)

    @app.cli.command("prepare-official-teams")
    def prepare():
        """Prepare this auction's five official team names and logos safely."""
        if not current_app.config["OFFICIAL_TEAMS"]:
            raise click.ClickException("Official team presets are disabled in this test instance.")
        changed = prepare_official_teams()
        click.echo(
            "Official five teams prepared. Existing players and auction rules are unchanged."
            if changed else "Official five teams already configured; no changes made."
        )
