"""Opt-in integration suite; uses isolated schemas, never real auction records."""
from concurrent.futures import ThreadPoolExecutor
import os
import secrets
import tempfile
import threading
import unittest

from dotenv import load_dotenv
from flask_migrate import upgrade
from sqlalchemy import create_engine, text

from app import create_app
from extensions import db
import test_auction


@unittest.skipUnless(os.environ.get("RUN_POSTGRES_TESTS") == "1", "Opt-in PostgreSQL suite")
class PostgreSQLAuctionTests(test_auction.AuctionFlowTests):
    def setUp(self):
        load_dotenv(".env")
        self.folder = tempfile.TemporaryDirectory()
        base = create_app()
        self.uri = base.config["SQLALCHEMY_DATABASE_URI"]
        self.schema = "auction_check_" + secrets.token_hex(12)
        self.admin_engine = create_engine(self.uri, connect_args={"connect_timeout": 5})
        with self.admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.config = {
            "TESTING": True, "SECRET_KEY": "test-only-key",
            "HOST_PASSWORD_HASH": self.password_hash,
            "SQLALCHEMY_DATABASE_URI": self.uri,
            "SQLALCHEMY_ENGINE_OPTIONS": {"connect_args": {
                "connect_timeout": 5, "options": f"-csearch_path={self.schema}",
            }},
            "UPLOAD_FOLDER": self.folder.name, "RATELIMIT_ENABLED": False,
            "OFFICIAL_TEAMS": False,
        }
        self.app = create_app(self.config)
        self.context = self.app.app_context()
        self.context.push()
        upgrade(directory=self.app.extensions["migrate"].directory)
        self.client = self.app.test_client()
        token = self.client.get("/api/auth/session").json["csrf_token"]
        login = self.client.post("/api/auth/login",
            json={"password": "test-only-password"}, headers={"X-CSRF-Token": token})
        self.headers = {"X-CSRF-Token": login.json["csrf_token"]}
        from test_auction import image_bytes
        self.path = self.client.post("/api/uploads",
            data={"file": (image_bytes(), "test.png")}, headers=self.headers).json["path"]

    def tearDown(self):
        db.session.remove()
        db.engine.dispose()
        self.context.pop()
        with self.admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        self.admin_engine.dispose()
        self.folder.cleanup()

    def test_restart_recovers_state_and_signed_host_session(self):
        state = self.setup_profiles()
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        self.action("bid", team_id=state["teams"][0]["id"])
        before = self.state()
        cookie = self.client.get_cookie("venomsfc_session")
        restarted = create_app(self.config)
        client = restarted.test_client()
        client.set_cookie("venomsfc_session", cookie.value)
        self.assertEqual(client.get("/api/auction/state").json, before)
        self.assertTrue(client.get("/api/auth/session").json["authenticated"])
        self.assertEqual(client.get("/api/auction/history").status_code, 200)
        with restarted.app_context():
            db.session.remove()
            db.engine.dispose()

    def test_concurrent_bids_have_one_winner_and_retry_is_idempotent(self):
        state = self.setup_profiles()
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        version = self.state()["version"]
        cookie = self.client.get_cookie("venomsfc_session")
        barrier = threading.Barrier(2)

        def bid(team):
            client = self.app.test_client()
            client.set_cookie("venomsfc_session", cookie.value)
            barrier.wait(timeout=10)
            payload = {
                "action": "bid", "team_id": team, "expected_version": version,
                "request_id": secrets.token_hex(16),
            }
            response = client.post("/api/auction/actions", headers=self.headers, json=payload)
            if response.status_code == 200:
                duplicate = client.post("/api/auction/actions", headers=self.headers, json=payload)
                assert duplicate.status_code == 200
                assert duplicate.json["current"]["bid"] == 10
            return response.status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(bid, [team["id"] for team in state["teams"][:2]]))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(self.state()["current"]["bid"], 10)


if __name__ == "__main__":
    unittest.main()
