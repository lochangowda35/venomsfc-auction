"""Tournament host authentication, independent of auction sessions."""
from datetime import datetime, timedelta, timezone
from functools import wraps
import secrets

from flask import Blueprint, current_app, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import delete
from werkzeug.security import check_password_hash

from auth import limiter, token_hash
from extensions import db
from models import CupHostSession


cup_auth = Blueprint("cup_auth", __name__, url_prefix="/api/cup-auth")
COOKIE_NAME = "venomsfc_cup_session"
SESSION_SECONDS = 8 * 60 * 60


def _serializer():
    return URLSafeTimedSerializer(current_app.secret_key, salt="venomsfc-cup-host-v1")


def _cookie():
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        return {}
    try:
        data = _serializer().loads(raw, max_age=SESSION_SECONDS)
    except (BadSignature, SignatureExpired):
        return {}
    return data if isinstance(data, dict) else {}


def _set_cookie(response, data):
    response.set_cookie(
        COOKIE_NAME, _serializer().dumps(data), max_age=SESSION_SECONDS,
        httponly=True, secure=current_app.config["SESSION_COOKIE_SECURE"],
        samesite="Strict", path="/",
    )
    return response


def current_cup_host_session():
    token = _cookie().get("token")
    if not isinstance(token, str) or "sqlalchemy" not in current_app.extensions:
        return None
    record = db.session.get(CupHostSession, token_hash(token))
    if record is None:
        return None
    expires = record.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return record if expires > datetime.now(timezone.utc) else None


def cup_host_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_cup_host_session() is None:
            return jsonify(error="Tournament host login required."), 401
        return view(*args, **kwargs)
    return wrapped


def check_cup_csrf():
    expected = _cookie().get("csrf")
    supplied = request.headers.get("X-CSRF-Token", "")
    if not isinstance(expected, str) or not secrets.compare_digest(expected, supplied):
        return jsonify(error="Invalid tournament CSRF token. Refresh and retry."), 403


@cup_auth.before_request
def protect_requests():
    if not current_app.secret_key or not current_app.config["HOST_PASSWORD_HASH"]:
        return jsonify(error="Tournament host login is not configured."), 503
    if "sqlalchemy" not in current_app.extensions:
        return jsonify(error="Tournament host login requires a configured database."), 503
    if request.method == "POST":
        return check_cup_csrf()


@cup_auth.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@cup_auth.get("/session")
def session_status():
    data = _cookie()
    csrf = data.get("csrf")
    if not isinstance(csrf, str):
        data = {"csrf": secrets.token_urlsafe(32)}
    response = jsonify(authenticated=current_cup_host_session() is not None, csrf_token=data["csrf"])
    return _set_cookie(response, data) if data != _cookie() else response


@cup_auth.post("/login")
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
    previous = current_cup_host_session()
    if previous is not None:
        db.session.delete(previous)
    db.session.execute(delete(CupHostSession).where(CupHostSession.expires_at <= datetime.now(timezone.utc)))
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    db.session.add(CupHostSession(
        token_hash=token_hash(token), expires_at=datetime.now(timezone.utc) + timedelta(seconds=SESSION_SECONDS),
    ))
    db.session.commit()
    return _set_cookie(jsonify(authenticated=True, csrf_token=csrf), {"token": token, "csrf": csrf})


@cup_auth.post("/logout")
def logout():
    record = current_cup_host_session()
    if record is not None:
        db.session.delete(record)
        db.session.commit()
    response = jsonify(authenticated=False)
    response.delete_cookie(COOKIE_NAME, path="/", samesite="Strict")
    return response
