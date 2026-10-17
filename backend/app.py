import os
from datetime import timedelta
from pathlib import Path

import click
import psycopg
from dotenv import set_key
from flask import Flask, jsonify, redirect, request, send_from_directory
from sqlalchemy import URL, text
from sqlalchemy.exc import SQLAlchemyError

from extensions import db, migrate
from auth import current_host_session, init_auth
from profiles import profiles
from auction import auction_api, register_maintenance
from media import media
from demo_seed import register_demo_seed
from branding import register_branding
import models


def create_app(test_config=None):
    app = Flask(__name__)
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY"),
        HOST_PASSWORD_HASH=os.environ.get("HOST_PASSWORD_HASH"),
        SESSION_COOKIE_NAME="venomsfc_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE") == "1",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        SESSION_REFRESH_EACH_REQUEST=False,
        UPLOAD_FOLDER=str(Path(__file__).parent / "uploads"),
        MAX_CONTENT_LENGTH=6 * 1024 * 1024,
        OFFICIAL_TEAMS=True,
    )

    if os.environ.get("PGDATABASE"):
        app.config["SQLALCHEMY_DATABASE_URI"] = URL.create(
            "postgresql+psycopg",
            username=os.environ.get("PGUSER", "venomsfc_app"),
            password=os.environ.get("PGPASSWORD"),
            host=os.environ.get("PGHOST", "127.0.0.1"),
            port=int(os.environ.get("PGPORT", "5432")),
            database=os.environ["PGDATABASE"],
        )
        app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
            "pool_pre_ping": True,
            "connect_args": {"connect_timeout": 5},
        }

    if test_config is not None:
        app.config.update(test_config)

    if app.config.get("SQLALCHEMY_DATABASE_URI"):
        db.init_app(app)
        migrate.init_app(app, db, directory=str(Path(__file__).parent / "migrations"))

    init_auth(app)
    app.register_blueprint(profiles)
    app.register_blueprint(auction_api)
    app.register_blueprint(media)
    register_demo_seed(app)
    register_maintenance(app)
    register_branding(app)

    @app.errorhandler(413)
    def too_large(error):
        return jsonify(error="Request too large. Images must be at most 5 MB."), 413

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", message="Hello from the Venoms FC Flask backend!")

    @app.get("/")
    @app.get("/host")
    @app.get("/display")
    @app.get("/spectate")
    def frontend_page():
        if request.path == "/display" and current_host_session() is None:
            response = redirect("/host?next=display")
            response.headers["Cache-Control"] = "no-store"
            return response
        response = send_from_directory(
            Path(__file__).parent.parent / "frontend" / "dist", "index.html"
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/assets/<path:name>")
    def frontend_asset(name):
        return send_from_directory(
            Path(__file__).parent.parent / "frontend" / "dist" / "assets", name
        )

    @app.cli.command("configure-db")
    def configure_db():
        """Verify and save this local project's database connection."""
        settings = {
            "PGHOST": "127.0.0.1",
            "PGPORT": "5432",
            "PGDATABASE": "venomsfc_auction",
            "PGUSER": "venomsfc_app",
        }
        password = click.prompt(
            "Password for venomsfc_app", hide_input=True, confirmation_prompt=True
        )
        try:
            with psycopg.connect(
                host=settings["PGHOST"],
                port=settings["PGPORT"],
                dbname=settings["PGDATABASE"],
                user=settings["PGUSER"],
                password=password,
                connect_timeout=5,
            ) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT current_user, current_database()")
                    identity = cursor.fetchone()
        except psycopg.Error:
            raise click.ClickException(
                "Database connection failed. Check the PostgreSQL service, app "
                "password, and local database setup. Configuration was not saved."
            ) from None

        if identity != ("venomsfc_app", "venomsfc_auction"):
            raise click.ClickException(
                "Unexpected database identity. Configuration was not saved."
            )

        env_path = Path(__file__).parent / ".env"
        for key, value in {**settings, "PGPASSWORD": password}.items():
            set_key(env_path, key, value)
        click.echo("Connection verified. Settings saved privately in backend/.env.")
        click.echo("Restart Flask to load the database settings.")

    @app.cli.command("db-check")
    def db_check():
        """Check a real database query through SQLAlchemy."""
        if "sqlalchemy" not in app.extensions:
            raise click.ClickException(
                "Database is not configured. Run flask --app app configure-db first."
            )
        try:
            with db.engine.connect() as connection:
                identity = connection.execute(
                    text("SELECT current_user, current_database()")
                ).one()
        except SQLAlchemyError:
            raise click.ClickException(
                "Database query failed. Check PostgreSQL and your backend/.env settings."
            ) from None
        click.echo(f"Database connected: user={identity[0]}, database={identity[1]}")

    return app
