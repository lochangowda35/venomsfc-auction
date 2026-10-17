from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

from sqlalchemy.exc import OperationalError
from werkzeug.security import generate_password_hash

from app import create_app
from extensions import db
from models import HostSession, Player, Team


class ProfileApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = generate_password_hash("test-host-password")

    def setUp(self):
        media_patch = patch("profiles.valid_media_path", return_value=True)
        media_patch.start()
        self.addCleanup(media_patch.stop)
        self.app = create_app({
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
            "SECRET_KEY": "test-only",
            "HOST_PASSWORD_HASH": self.password_hash,
            "RATELIMIT_ENABLED": False,
            "OFFICIAL_TEAMS": False,
        })
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        self.client = self.app.test_client()
        csrf = self.client.get("/api/auth/session").json["csrf_token"]
        login = self.client.post(
            "/api/auth/login", json={"password": "test-host-password"},
            headers={"X-CSRF-Token": csrf},
        )
        self.headers = {"X-CSRF-Token": login.json["csrf_token"]}

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
        self.context.pop()

    def test_anonymous_and_expired_sessions_cannot_read_or_write(self):
        anonymous = self.app.test_client()
        record = HostSession.query.one()
        record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()
        for client in (anonymous, self.client):
            for endpoint in ("teams", "players"):
                self.assertEqual(client.get(f"/api/{endpoint}").status_code, 401)
                self.assertEqual(client.post(f"/api/{endpoint}", json={}).status_code, 401)

    def test_creation_requires_csrf(self):
        for endpoint in ("teams", "players"):
            for headers in ({}, {"X-CSRF-Token": "invalid"}):
                response = self.client.post(f"/api/{endpoint}", json={}, headers=headers)
                self.assertEqual(response.status_code, 403)
        self.assertEqual(Team.query.count(), 0)
        self.assertEqual(Player.query.count(), 0)

    def test_profiles_are_trimmed_persisted_and_listed_in_id_order(self):
        for endpoint, singular, fields in (
            ("teams", "team", {"name": " Team ", "logo_path": " teams/logo.png "}),
            ("players", "player", {
                "name": " Player ", "photo_path": " players/photo.jpg ",
                "position": " MID ",
            }),
        ):
            self.assertEqual(self.client.get(f"/api/{endpoint}").json, {endpoint: []})
            created = []
            for _ in range(2):
                response = self.client.post(
                    f"/api/{endpoint}", json=fields, headers=self.headers
                )
                self.assertEqual(response.status_code, 201)
                record = response.json[singular]
                self.assertEqual(
                    {key: record[key] for key in fields},
                    {key: value.strip() for key, value in fields.items()},
                )
                created.append(record)
            db.session.remove()
            response = self.client.get(f"/api/{endpoint}")
            self.assertEqual(response.json, {endpoint: created})
            self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_team_limit_and_no_player_count_limit(self):
        for index in range(6):
            response = self.client.post(
                "/api/teams", json={"name": f"Team {index}", "logo_path": "logo.png"},
                headers=self.headers,
            )
            self.assertEqual(response.status_code, 201 if index < 5 else 409)
            response = self.client.post(
                "/api/players",
                json={"name": "Same Name", "photo_path": "photo.jpg", "position": "ST"},
                headers=self.headers,
            )
            self.assertEqual(response.status_code, 201)
        self.assertEqual(Team.query.count(), 5)
        self.assertEqual(Player.query.count(), 6)

    def test_invalid_fields_do_not_write_records(self):
        for endpoint, model, fields, limits in (
            ("teams", Team, {"name": "Team", "logo_path": "logo.png"}, (120, 500)),
            ("players", Player, {
                "name": "Player", "photo_path": "photo.jpg", "position": "ST",
            }, (120, 500, 80)),
        ):
            payloads = [[], None, "text", {**fields, "id": 100}]
            for (field, _), limit in zip(fields.items(), limits):
                missing = dict(fields)
                del missing[field]
                payloads.append(missing)
                for invalid in (None, "", " \t ", 1, True, [], {}, "x" * (limit + 1), "a\0b"):
                    payloads.append({**fields, field: invalid})
            for payload in payloads:
                with self.subTest(endpoint=endpoint, payload=payload):
                    response = self.client.post(
                        f"/api/{endpoint}", json=payload, headers=self.headers
                    )
                    self.assertEqual(response.status_code, 400)
                    self.assertIn("fields", response.json)
            self.assertEqual(model.query.count(), 0)

    def test_field_length_boundaries(self):
        for endpoint, fields in (
            ("teams", {"name": "n" * 120, "logo_path": "p" * 500}),
            ("players", {
                "name": "n" * 120, "photo_path": "p" * 500, "position": "GK",
            }),
        ):
            self.assertEqual(self.client.post(
                f"/api/{endpoint}", json=fields, headers=self.headers
            ).status_code, 201)

    def test_database_errors_are_explicit_without_private_details(self):
        with self.assertLogs(self.app.logger, level="ERROR"):
            with patch.object(db.session, "scalars", side_effect=OperationalError(
                "private query", {}, Exception("private details")
            )):
                response = self.client.get("/api/teams")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private", response.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
