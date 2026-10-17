"""Explicit, non-destructive sample data for a fresh local demo database."""
from pathlib import Path
import secrets

import click
from flask import current_app
from PIL import Image, ImageDraw
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from auction import locked_auction
from extensions import db
from models import Player, Team
from profiles import profile_changed


def register_demo_seed(app):
    @app.cli.command("seed-demo")
    @click.option("--squad-size", type=click.IntRange(1, 10), default=2, show_default=True)
    @click.confirmation_option(prompt="Add clearly named sample players to an unused setup, preserving the official teams?")
    def seed_demo(squad_size):
        """Opt in to sample players; never replaces existing profiles."""
        record = locked_auction()
        official = current_app.config["OFFICIAL_TEAMS"]
        from branding import OFFICIAL_TEAMS
        teams = db.session.scalars(select(Team)).all()
        expected = {name: f"/api/branding/{file}" for name, file in OFFICIAL_TEAMS}
        teams_ok = not teams or (
            official and len(teams) == 5
            and {team.name: team.logo_path for team in teams} == expected
        )
        if (
            record.state["status"] != "setup"
            or not teams_ok
            or db.session.scalar(select(func.count()).select_from(Player))
        ):
            db.session.rollback()
            raise click.ClickException(
                "Sample data requires no players, only the official teams (or no teams), "
                "and setup mode. Existing data was not changed."
            )
        folder = Path(current_app.config["UPLOAD_FOLDER"])
        folder.mkdir(parents=True, exist_ok=True)
        created = []

        def sample_image(label, color):
            image = Image.new("RGB", (480, 480), "#0b1420")
            draw = ImageDraw.Draw(image)
            draw.ellipse((90, 45, 390, 345), fill=color)
            draw.rounded_rectangle((45, 330, 435, 450), radius=24, fill=color)
            draw.text((145, 220), label, fill="white", font_size=42)
            name = secrets.token_hex(16) + ".jpg"
            path = folder / name
            created.append(path)
            image.save(path, "JPEG", quality=88)
            return "/api/media/" + name

        try:
            colors = ["#0c846e", "#7c3aed", "#c85c18", "#2367bd", "#be3555"]
            if not teams:
                if official:
                    for name, file in OFFICIAL_TEAMS:
                        db.session.add(Team(name=name, logo_path=f"/api/branding/{file}"))
                else:
                    for index, color in enumerate(colors):
                        db.session.add(Team(
                            name=f"Demo Team {index + 1}",
                            logo_path=sample_image(f"FC {index + 1}", color),
                        ))
            for index in range(5 * squad_size + 2):
                db.session.add(Player(
                    name=f"Demo Player {index + 1:02d}",
                    photo_path=sample_image(f"#{index + 1:02d}", colors[index % 5]),
                    position=("GK", "DEF", "MID", "ST")[index % 4],
                ))
            db.session.flush()
            state = dict(record.state)
            state["squad_size"] = squad_size
            all_teams = db.session.scalars(select(Team).order_by(Team.id)).all()
            demo_players = db.session.scalars(select(Player).order_by(Player.id)).all()
            state["captains"] = {
                str(team.id): {"player_id": player.id, "price": 10}
                for team, player in zip(all_teams, demo_players)
            }
            record.state = state
            profile_changed(record, "demo", "seed")
            db.session.commit()
        except (OSError, ValueError, SQLAlchemyError):
            db.session.rollback()
            for path in created:
                path.unlink(missing_ok=True)
            raise click.ClickException("Sample image creation failed; no profiles were saved.") from None
        click.echo(
            f"Prepared {'5 official teams' if official else '5 demo teams'} "
            f"and {5 * squad_size + 2} demo players. "
            f"Squad size is {squad_size}; the first five demo players are 10-point captains; "
            "auction has not started."
        )
