from datetime import datetime, timedelta, timezone
from functools import wraps
import hashlib
from pathlib import Path
import secrets

import click
from dotenv import set_key
from flask import Blueprint, current_app, jsonify, request, session
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy import delete
from sqlalchemy.exc import SQLAlchemyError
from werkzeug.security import check_password_hash, generate_password_hash

from extensions import db
from models import HostSession


auth = Blueprint("auth", __name__, url_prefix="/api/auth")
limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def current_host_session():
    token = session.get("host_token")
    if not token or "sqlalchemy" not in current_app.extensions:
        return None
    record = db.session.get(HostSession, token_hash(token))
    if record is None:
        return None
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        db.session.delete(record)
        db.session.commit()
        session.pop("host_token", None)
        return None
    return record


def host_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_host_session() is None:
            return jsonify(error="Host login required."), 401
        return view(*args, **kwargs)
    return wrapped


def check_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    if not expected or not secrets.compare_digest(expected.encode(), supplied.encode()):
        return jsonify(error="Invalid CSRF token. Refresh the session and retry."), 403


@auth.before_request
def protect_auth_requests():
    if not current_app.secret_key or not current_app.config["HOST_PASSWORD_HASH"]:
        return jsonify(error="Host login is not configured."), 503
    if "sqlalchemy" not in current_app.extensions:
        return jsonify(error="Host login requires a configured database."), 503
    if request.method == "POST":
        return check_csrf()


@auth.after_request
def prevent_caching(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@auth.get("/session")
def session_status():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify(
        authenticated=current_host_session() is not None,
        csrf_token=session["csrf_token"],
    )


@auth.post("/login")
@limiter.limit("5 per minute")
def login():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or set(data) != {"password"}:
        return jsonify(error="Provide a JSON object containing only password."), 400
    password = data["password"]
    if not isinstance(password, str) or not 1 <= len(password) <= 256:
        return jsonify(error="Password must be a string of 1 to 256 characters."), 400
    if not check_password_hash(current_app.config["HOST_PASSWORD_HASH"], password):
        return jsonify(error="Incorrect host password."), 401

    previous = current_host_session()
    if previous is not None:
        db.session.delete(previous)
    db.session.execute(delete(HostSession).where(
        HostSession.expires_at <= datetime.now(timezone.utc)
    ))
    token = secrets.token_urlsafe(32)
    db.session.add(HostSession(
        token_hash=token_hash(token),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=8),
    ))
    db.session.commit()
    session.clear()
    session.permanent = True
    session["host_token"] = token
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify(authenticated=True, csrf_token=session["csrf_token"])


@auth.post("/logout")
def logout():
    record = current_host_session()
    if record is not None:
        db.session.delete(record)
        db.session.commit()
    session.clear()
    return jsonify(authenticated=False)


def init_auth(app):
    limiter.init_app(app)
    app.register_blueprint(auth)

    @app.errorhandler(SQLAlchemyError)
    def database_unavailable(error):
        db.session.rollback()
        app.logger.error("Database operation failed; check database service and migrations.")
        response = jsonify(error="Database operation failed. Please retry later.")
        response.status_code = 503
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(429)
    def rate_limited(error):
        response = jsonify(error="Too many login attempts. Wait one minute and retry.")
        response.status_code = 429
        response.headers["Retry-After"] = "60"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.cli.command("configure-host")
    def configure_host():
        """Set the single host password without exposing it in shell history."""
        password = click.prompt(
            "New host password (12-256 characters)",
            hide_input=True,
            confirmation_prompt=True,
        )
        if not 12 <= len(password) <= 256:
            raise click.ClickException("Use a password of 12 to 256 characters.")
        if "sqlalchemy" not in app.extensions:
            raise click.ClickException("Configure the database and apply migrations first.")
        db.session.execute(delete(HostSession))
        db.session.commit()
        env_path = Path(__file__).parent / ".env"
        set_key(env_path, "HOST_PASSWORD_HASH", generate_password_hash(password))
        set_key(env_path, "SECRET_KEY", secrets.token_hex(32))
        click.echo("Host password hash and signing key saved privately in backend/.env.")
        click.echo("All host sessions revoked. Restart Flask to load the new settings.")
