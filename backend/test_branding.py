import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
import tempfile
from io import BytesIO

from PIL import Image

from werkzeug.security import generate_password_hash

from app import create_app
from branding import ASSETS, OFFICIAL_TEAMS, prepare_official_teams
from extensions import db
from models import Auction, HostSession, Player, Team


class OfficialBrandingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = generate_password_hash("official-test-password")

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.app = create_app({
            "TESTING": True, "SECRET_KEY": "test-only",
            "HOST_PASSWORD_HASH": self.password_hash,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {}, "RATELIMIT_ENABLED": False,
            "UPLOAD_FOLDER": self.folder.name, "OFFICIAL_TEAMS": True,
        })
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        self.client = self.app.test_client()
        csrf = self.client.get("/api/auth/session").json["csrf_token"]
        login = self.client.post("/api/auth/login", json={"password": "official-test-password"},
            headers={"X-CSRF-Token": csrf})
        self.headers = {"X-CSRF-Token": login.json["csrf_token"]}

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
        self.context.pop()
        self.folder.cleanup()

    def test_official_presets_are_idempotent_and_public_with_real_images(self):
        self.assertTrue(prepare_official_teams())
        state = self.app.test_client().get("/api/auction/state").json
        self.assertTrue(state["fixed_teams"])
        self.assertEqual([team["name"] for team in state["teams"]],
                         [name for name, _ in OFFICIAL_TEAMS])
        self.assertEqual([team["budget"] for team in state["teams"]], [1000] * 5)
        self.assertFalse(prepare_official_teams())
        self.assertEqual(self.client.get("/api/auction/state").json, state)
        for name in ASSETS:
            response = self.client.get(f"/api/branding/{name}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "image/jpeg")
            response.close()
        self.assertEqual(self.client.get("/api/branding/private.env").status_code, 404)
        from media import valid_media_path
        for _, file in OFFICIAL_TEAMS:
            self.assertTrue(valid_media_path(f"/api/branding/{file}"))
        self.assertFalse(valid_media_path("/api/branding/auction-banner.jpg"))

    def test_host_cannot_add_rename_replace_or_delete_official_teams(self):
        prepare_official_teams()
        for method, path in (
            ("POST", "/api/teams"), ("PUT", "/api/teams/1"), ("DELETE", "/api/teams/1")
        ):
            result = self.client.open(path, method=method, headers=self.headers,
                json={"name": "Changed", "logo_path": "/api/branding/cobras.jpg"})
            self.assertEqual(result.status_code, 409)
            self.assertIn("fixed", result.json["error"])
        self.assertEqual(Team.query.count(), 5)

    def test_display_crests_are_square_and_fill_the_frame_without_replacing_originals(self):
        for name in ("blackmambas", "vipers"):
            original = self.client.get(f"/api/branding/{name}.jpg")
            display = self.client.get(f"/api/branding/{name}-crest.jpg")
            with Image.open(BytesIO(original.data)) as image:
                self.assertEqual(image.size, (1280, 714))
            with Image.open(BytesIO(display.data)) as image:
                self.assertEqual(image.size, (800, 800))
                highlights = image.convert("L").point(lambda value: 255 if value > 80 else 0)
                left, top, right, bottom = highlights.getbbox()
                self.assertGreater(right - left, 800 * .85)
                self.assertGreater(bottom - top, 800 * .85)
            original.close()
            display.close()

    def test_existing_unrelated_data_is_never_replaced(self):
        db.session.add(Team(name="Existing Club", logo_path="old.png"))
        db.session.add(Player(name="Existing Player", position="MID", photo_path="old.png"))
        db.session.commit()
        result = self.app.test_cli_runner().invoke(args=["prepare-official-teams"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("No records were replaced", result.output)
        self.assertEqual(Team.query.one().name, "Existing Club")
        self.assertEqual(Player.query.one().name, "Existing Player")

    def test_matching_team_ids_are_preserved_when_official_logos_are_applied(self):
        for name, _ in OFFICIAL_TEAMS:
            db.session.add(Team(name=name, logo_path="old-upload.jpg"))
        db.session.commit()
        ids = {team.name: team.id for team in Team.query.all()}
        self.assertTrue(prepare_official_teams())
        self.assertEqual({team.name: team.id for team in Team.query.all()}, ids)
        self.assertFalse(prepare_official_teams())

    def test_opt_in_sample_players_preserve_official_teams_and_refuse_a_second_seed(self):
        prepare_official_teams()
        ids = [team.id for team in Team.query.all()]
        result = self.app.test_cli_runner().invoke(args=["seed-demo", "--squad-size", "1", "--yes"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual([team.id for team in Team.query.all()], ids)
        self.assertEqual(Player.query.count(), 7)
        before = self.client.get("/api/auction/state").json
        self.assertNotEqual(self.app.test_cli_runner().invoke(args=["seed-demo", "--yes"]).exit_code, 0)
        self.assertEqual(self.client.get("/api/auction/state").json, before)

    def test_private_display_and_host_state_require_session_and_logout_revokes_both(self):
        public = self.app.test_client()
        self.assertEqual(public.get("/api/auction/state").status_code, 200)
        for path in ("/api/auction/host-state", "/api/auction/display-state"):
            self.assertEqual(public.get(path).status_code, 401)
            self.assertEqual(self.client.get(path).status_code, 200)
        response = public.get("/display")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/host?next=display")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        with patch("app.send_from_directory") as send:
            send.return_value = self.app.response_class("private shell")
            self.assertEqual(self.client.get("/display").status_code, 200)
        self.client.post("/api/auth/logout", headers=self.headers)
        self.assertEqual(self.client.get("/api/auction/display-state").status_code, 401)
        self.assertEqual(self.client.get("/display").status_code, 302)

    def test_expired_session_cannot_read_private_display(self):
        record = HostSession.query.one()
        record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()
        self.assertEqual(self.client.get("/api/auction/display-state").status_code, 401)

    def test_official_logos_satisfy_start_without_uploading_copies(self):
        prepare_official_teams()
        from test_auction import image_bytes
        photo = self.client.post("/api/uploads", headers=self.headers,
            data={"file": (image_bytes(), "test.png")}).json["path"]
        for index in range(5):
            self.client.post("/api/players", headers=self.headers,
                json={"name": f"Player {index}", "photo_path": photo, "position": "MID"})
        state = self.client.get("/api/auction/state").json
        for team, player in zip(state["teams"], state["players"]):
            state = self.client.get("/api/auction/state").json
            result = self.client.post("/api/auction/actions", headers=self.headers, json={
                "action": "captain", "team_id": team["id"], "player_id": player["id"], "price": 10,
                "expected_version": state["version"], "request_id": f"captain-{team['id']}",
            })
            self.assertEqual(result.status_code, 200, result.json)
        state = self.client.get("/api/auction/state").json
        result = self.client.post("/api/auction/actions", headers=self.headers, json={
            "action": "start", "expected_version": state["version"], "request_id": "official-start",
        })
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json["status"], "completed")
        self.assertFalse(prepare_official_teams())
        self.assertEqual(db.session.get(Auction, 1).state["status"], "completed")
