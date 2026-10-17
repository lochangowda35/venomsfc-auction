"""Disposable PostgreSQL/browser-test host. Never points at real auction tables."""
import argparse
import os
from pathlib import Path
import re
import shutil
import tempfile

from dotenv import load_dotenv
from flask_migrate import upgrade
from sqlalchemy import create_engine, text
from werkzeug.security import generate_password_hash

from app import create_app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--port", type=int, default=5001)
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"browser_check_[a-f0-9]{24}", args.schema):
        parser.error("Use browser_check_ followed by 24 random hexadecimal characters.")
    load_dotenv(Path(__file__).parent / ".env")
    base = create_app()
    uri = base.config["SQLALCHEMY_DATABASE_URI"]
    engine = create_engine(uri, connect_args={"connect_timeout": 5})
    if args.cleanup:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{args.schema}" CASCADE'))
        engine.dispose()
        uploads = Path(tempfile.gettempdir()) / args.schema
        if uploads.is_dir():
            shutil.rmtree(uploads)
        print("Disposable browser-test database schema removed.")
        return
    password = os.environ.get("BROWSER_TEST_PASSWORD")
    signing_key = os.environ.get("BROWSER_TEST_SIGNING_KEY")
    if not password or not signing_key:
        parser.error("Set ephemeral BROWSER_TEST_PASSWORD and BROWSER_TEST_SIGNING_KEY.")
    with engine.begin() as connection:
        exists = connection.execute(
            text("SELECT 1 FROM information_schema.schemata WHERE schema_name=:name"),
            {"name": args.schema},
        ).scalar()
        if not exists:
            connection.execute(text(f'CREATE SCHEMA "{args.schema}"'))
    engine.dispose()
    upload_folder = Path(tempfile.gettempdir()) / args.schema
    app = create_app({
        "SQLALCHEMY_DATABASE_URI": uri,
        "SQLALCHEMY_ENGINE_OPTIONS": {"connect_args": {
            "connect_timeout": 5, "options": f"-csearch_path={args.schema}",
        }},
        "SECRET_KEY": signing_key,
        "HOST_PASSWORD_HASH": generate_password_hash(password),
        "UPLOAD_FOLDER": str(upload_folder),
        "RATELIMIT_ENABLED": False,
        "OFFICIAL_TEAMS": os.environ.get("BROWSER_TEST_OFFICIAL_TEAMS") == "1",
    })
    with app.app_context():
        upgrade(directory=app.extensions["migrate"].directory)
        if app.config["OFFICIAL_TEAMS"]:
            from branding import prepare_official_teams
            prepare_official_teams()
    app.run(host="127.0.0.1", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
