from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

from werkzeug.security import generate_password_hash

from app import create_app
from auth import host_required, limiter
from extensions import db
from models import HostSession


class HostAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = generate_password_hash("test-host-password")

    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
            "SECRET_KEY": "test-only-signing-key",
            "HOST_PASSWORD_HASH": self.password_hash,
            "RATELIMIT_ENABLED": False,
        })
        self.app.add_url_rule(
            "/test-host-only", view_func=host_required(lambda: {"ok": True})
        )
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        self.client = self.app.test_client()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
        self.context.pop()

    def csrf(self, client=None):
        return (client or self.client).get("/api/auth/session").json["csrf_token"]

    def login(self):
        return self.client.post(
            "/api/auth/login",
            json={"password": "test-host-password"},
            headers={"X-CSRF-Token": self.csrf()},
        )

    def test_login_status_logout_and_revocation(self):
        self.assertEqual(self.client.get("/test-host-only").status_code, 401)
        anonymous_csrf = self.csrf()
        response = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertNotEqual(response.json["csrf_token"], anonymous_csrf)
        cookie = self.client.get_cookie("venomsfc_session")
        self.assertTrue(cookie.http_only)
        self.assertEqual(cookie.same_site, "Strict")
        self.assertTrue(self.client.get("/api/auth/session").json["authenticated"])
        self.assertEqual(self.client.get("/test-host-only").status_code, 200)
        self.assertEqual(HostSession.query.count(), 1)
        result = self.client.post(
            "/api/auth/logout", headers={"X-CSRF-Token": response.json["csrf_token"]}
        )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(HostSession.query.count(), 0)
        replay = self.app.test_client()
        replay.set_cookie("venomsfc_session", cookie.value)
        self.assertEqual(replay.get("/test-host-only").status_code, 401)

    def test_bad_password_and_invalid_payloads(self):
        token = self.csrf()
        for payload, status in (
            ({"password": "wrong"}, 401), ({}, 400), ([], 400),
            ({"password": 123}, 400), ({"password": "x" * 257}, 400),
        ):
            with self.subTest(payload=payload):
                result = self.client.post(
                    "/api/auth/login", json=payload, headers={"X-CSRF-Token": token}
                )
                self.assertEqual(result.status_code, status)
        self.assertEqual(HostSession.query.count(), 0)

    def test_csrf_required_for_login_and_logout(self):
        for endpoint in ("login", "logout"):
            response = self.client.post(
                f"/api/auth/{endpoint}", json={"password": "test-host-password"}
            )
            self.assertEqual(response.status_code, 403)
        self.login()
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 403)
        self.assertTrue(self.client.get("/api/auth/session").json["authenticated"])
        self.assertEqual(self.client.post(
            "/api/auth/logout", headers={"X-CSRF-Token": "\u00e9"}
        ).status_code, 403)

    def test_login_attempts_are_throttled(self):
        with patch.object(limiter, "enabled", True):
            limiter.reset()
            token = self.csrf()
            for _ in range(5):
                response = self.client.post(
                    "/api/auth/login", json={"password": "wrong"},
                    headers={"X-CSRF-Token": token},
                )
                self.assertEqual(response.status_code, 401)
            response = self.client.post(
                "/api/auth/login", json={"password": "test-host-password"},
                headers={"X-CSRF-Token": token},
            )
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["Retry-After"], "60")
            self.assertIn("Too many login attempts", response.json["error"])
            limiter.reset()

    def test_tunnel_throttles_each_visitor_separately(self):
        self.app.config["TRUST_CLOUDFLARE"] = True
        with patch.object(limiter, "enabled", True):
            limiter.reset()
            token = self.csrf()
            for _ in range(5):
                self.client.post(
                    "/api/auth/login", json={"password": "wrong"},
                    headers={"X-CSRF-Token": token, "CF-Connecting-IP": "203.0.113.5"},
                )
            blocked = self.client.post(
                "/api/auth/login", json={"password": "wrong"},
                headers={"X-CSRF-Token": token, "CF-Connecting-IP": "203.0.113.5"},
            )
            self.assertEqual(blocked.status_code, 429)
            other = self.client.post(
                "/api/auth/login", json={"password": "test-host-password"},
                headers={"X-CSRF-Token": token, "CF-Connecting-IP": "198.51.100.7"},
            )
            self.assertEqual(other.status_code, 200)
            limiter.reset()

    def test_repeat_login_revokes_previous_cookie(self):
        self.login()
        old_cookie = self.client.get_cookie("venomsfc_session")
        self.login()
        replay = self.app.test_client()
        replay.set_cookie("venomsfc_session", old_cookie.value)
        self.assertEqual(replay.get("/test-host-only").status_code, 401)
        self.assertEqual(HostSession.query.count(), 1)

    def test_expired_and_tampered_sessions_are_rejected(self):
        self.login()
        record = HostSession.query.one()
        record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()
        self.assertEqual(self.client.get("/test-host-only").status_code, 401)
        self.assertEqual(HostSession.query.count(), 0)
        self.client.set_cookie("venomsfc_session", "tampered")
        self.assertFalse(self.client.get("/api/auth/session").json["authenticated"])

    def test_missing_config_fails_closed_and_responses_are_not_cached(self):
        self.app.config["HOST_PASSWORD_HASH"] = None
        response = self.client.get("/api/auth/session")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    @patch("auth.set_key")
    def test_password_configuration_hashes_password_and_revokes_sessions(self, set_key):
        self.login()
        result = self.app.test_cli_runner().invoke(
            args=["configure-host"], input="new-host-password\nnew-host-password\n"
        )
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(HostSession.query.count(), 0)
        self.assertEqual(set_key.call_count, 2)
        self.assertNotEqual(set_key.call_args_list[0].args[2], "new-host-password")
        self.assertNotIn("new-host-password", result.output)

    @patch("auth.set_key")
    def test_short_host_password_is_not_saved(self, set_key):
        result = self.app.test_cli_runner().invoke(
            args=["configure-host"], input="short\nshort\n"
        )
        self.assertNotEqual(result.exit_code, 0)
        set_key.assert_not_called()


if __name__ == "__main__":
    unittest.main()
