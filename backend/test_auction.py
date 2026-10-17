from io import BytesIO
import json
from pathlib import Path
import secrets
import tempfile
import unittest

from PIL import Image
from sqlalchemy import select
from werkzeug.security import generate_password_hash

from app import create_app
from extensions import db
from models import AuctionEvent, Team, Player


def image_bytes():
    stream = BytesIO()
    Image.new("RGB", (80, 80), "green").save(stream, format="PNG")
    stream.seek(0)
    return stream


class AuctionFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = generate_password_hash("test-only-password")

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.app = create_app({
            "TESTING": True, "SECRET_KEY": "test-only-key",
            "HOST_PASSWORD_HASH": self.password_hash,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
            "UPLOAD_FOLDER": self.folder.name, "RATELIMIT_ENABLED": False,
            "OFFICIAL_TEAMS": False,
        })
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        self.client = self.app.test_client()
        token = self.client.get("/api/auth/session").json["csrf_token"]
        response = self.client.post("/api/auth/login",
            json={"password": "test-only-password"}, headers={"X-CSRF-Token": token})
        self.headers = {"X-CSRF-Token": response.json["csrf_token"]}
        self.path = self.client.post("/api/uploads",
            data={"file": (image_bytes(), "test.png")}, headers=self.headers).json["path"]

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
        self.context.pop()
        self.folder.cleanup()

    def state(self):
        response = self.client.get("/api/auction/state")
        self.assertEqual(response.status_code, 200)
        return response.json

    def action(self, action, status=200, **extra):
        version = self.state()["version"]
        response = self.client.post("/api/auction/actions", headers=self.headers,
            json={"action": action, "expected_version": version,
                  "request_id": secrets.token_hex(16), **extra})
        self.assertEqual(response.status_code, status, response.json)
        return response.json

    def setup_profiles(self, squad_size=1, extras=1):
        """Five teams, each with a 10-point GK captain, plus `squad_size` auctioned slots.

        The returned state lists only the auctionable (non-captain) MID players.
        """
        for index in range(5):
            response = self.client.post("/api/teams", headers=self.headers,
                json={"name": f"Team {index}", "logo_path": self.path})
            self.assertEqual(response.status_code, 201, response.json)
        for index in range(squad_size * 5 + extras):
            response = self.client.post("/api/players", headers=self.headers,
                json={"name": f"Player {index}", "photo_path": self.path, "position": "MID"})
            self.assertEqual(response.status_code, 201, response.json)
        captains = []
        for index in range(5):
            response = self.client.post("/api/players", headers=self.headers,
                json={"name": f"Captain {index}", "photo_path": self.path, "position": "GK"})
            self.assertEqual(response.status_code, 201, response.json)
            captains.append(response.json["player"]["id"])
        self.action("configure", squad_size=squad_size + 1)
        for team, captain in zip(self.state()["teams"], captains):
            self.action("captain", team_id=team["id"], player_id=captain, price=10)
        state = self.state()
        state["players"] = [p for p in state["players"] if not p["captain"]]
        return state

    def start(self, set_name="MID"):
        self.action("start")
        self.action("open_set", set_name=set_name)

    def test_full_five_team_auction_undo_and_public_state(self):
        state = self.setup_profiles()
        self.start()
        pid = state["players"][0]["id"]
        self.action("select", player_id=pid)
        self.action("pause")
        self.action("bid", status=409, team_id=state["teams"][0]["id"])
        self.action("resume")
        self.action("bid", team_id=state["teams"][0]["id"])
        self.action("bid", status=409, team_id=state["teams"][0]["id"])
        self.action("bid", team_id=state["teams"][1]["id"])
        self.assertEqual(self.state()["current"]["bid"], 20)
        self.action("undo")
        self.assertEqual(self.state()["current"]["bid"], 10)
        self.action("sold")
        self.assertEqual(self.state()["teams"][0]["budget"], 980)
        self.action("undo")
        self.assertEqual(self.state()["teams"][0]["budget"], 990)
        self.assertEqual(self.state()["current"]["bid"], 10)
        self.action("sold")
        second = state["players"][1]["id"]
        self.action("select", player_id=second)
        self.action("unsold")
        self.action("undo")
        self.assertEqual(self.state()["current"]["player_id"], second)
        self.action("unsold")
        self.action("reauction", player_id=second)
        for index in range(1, 5):
            self.action("select", player_id=state["players"][index]["id"])
            self.action("bid", status=409, team_id=state["teams"][0]["id"])
            self.action("bid", team_id=state["teams"][index]["id"])
            self.action("sold")
        self.assertEqual(self.state()["status"], "completed")
        self.assertEqual(sum(p["status"] == "available" for p in self.state()["players"]), 1)
        self.action("select", status=409, player_id=state["players"][-1]["id"])
        public = self.app.test_client()
        self.assertEqual(public.get("/api/auction/state").json, self.state())
        self.assertEqual(public.get("/api/auction/history").status_code, 401)
        self.assertEqual(public.post("/api/auction/actions", json={}).status_code, 401)
        history = self.client.get("/api/auction/history").json["events"]
        self.assertTrue(any(row["undone"] for row in history))
        self.assertFalse(any("before" in row or "request_id" in row for row in history))
        image_response = public.get(self.path)
        self.assertEqual(image_response.status_code, 200)
        image_response.close()

    def test_budget_reserve_jump_bids_and_full_capacity(self):
        state = self.setup_profiles(squad_size=2)
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        teams = state["teams"]
        # Captains cost 10, leaving 990. Alternate exact +10 bids; 10 stays reserved for one more slot.
        for index in range(98):
            self.action("bid", team_id=teams[index % 2]["id"])
        self.assertEqual(self.state()["current"]["bid"], 980)
        self.action("bid", status=409, team_id=teams[0]["id"])
        self.action("sold")
        self.assertEqual(self.state()["teams"][1]["budget"], 10)
        self.assertEqual(self.state()["teams"][1]["max_bid"], 10)
        self.action("select", player_id=state["players"][1]["id"])
        response = self.client.post("/api/auction/actions", headers=self.headers, json={
            "action": "bid", "team_id": teams[1]["id"], "amount": 500,
            "expected_version": self.state()["version"], "request_id": secrets.token_hex(16),
        })
        self.assertEqual(response.status_code, 400)
        self.action("bid", team_id=teams[1]["id"])
        self.action("sold")
        self.assertEqual(self.state()["teams"][1]["budget"], 0)
        self.assertEqual(self.state()["teams"][1]["remaining_slots"], 0)

    def test_idempotency_stale_versions_and_restart(self):
        state = self.setup_profiles()
        self.start()
        payload = {"action": "select", "player_id": state["players"][0]["id"],
                   "expected_version": self.state()["version"],
                   "request_id": secrets.token_hex(16)}
        first = self.client.post("/api/auction/actions", headers=self.headers, json=payload)
        second = self.client.post("/api/auction/actions", headers=self.headers, json=payload)
        self.assertEqual(first.json, second.json)
        changed = {**payload, "player_id": state["players"][1]["id"]}
        self.assertEqual(self.client.post(
            "/api/auction/actions", headers=self.headers, json=changed).status_code, 409)
        stale = {**payload, "request_id": secrets.token_hex(16)}
        self.assertEqual(self.client.post(
            "/api/auction/actions", headers=self.headers, json=stale).status_code, 409)
        self.assertEqual(self.state()["current"]["bid"], 0)
        self.action("sold", status=409)
        self.action("undo")
        self.assertIsNone(self.state()["current"])

    def test_setup_validation_edit_delete_and_freeze(self):
        self.action("start", status=409)
        self.action("configure", status=400, squad_size=True)
        state = self.setup_profiles()
        team_id = state["teams"][0]["id"]
        response = self.client.put(f"/api/teams/{team_id}", headers=self.headers,
            json={"name": "Corrected", "logo_path": self.path})
        self.assertEqual(response.status_code, 200)
        pid = state["players"][-1]["id"]
        self.assertEqual(self.client.delete(
            f"/api/players/{pid}", headers=self.headers).status_code, 200)
        captain = next(p for p in self.state()["players"] if p["captain"])
        self.assertEqual(self.client.delete(
            f"/api/players/{captain['id']}", headers=self.headers).status_code, 409)
        self.assertEqual(self.client.delete(
            f"/api/teams/{captain['team_id']}", headers=self.headers).status_code, 409)
        self.action("start")
        self.assertEqual(self.client.put(f"/api/teams/{team_id}", headers=self.headers,
            json={"name": "Forbidden", "logo_path": self.path}).status_code, 409)
        self.assertEqual(self.client.delete(
            f"/api/teams/{team_id}", headers=self.headers).status_code, 409)
        self.action("configure", status=409, squad_size=2)

    def test_images_and_position_validation(self):
        response = self.client.post("/api/uploads", headers=self.headers,
            data={"file": (BytesIO(b"<svg>unsafe</svg>"), "file.svg")})
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/uploads", headers=self.headers,
            data={"file": (BytesIO(b"x" * (5 * 1024 * 1024 + 1)), "large.jpg")})
        self.assertEqual(response.status_code, 413)
        animated = BytesIO()
        Image.new("RGB", (10, 10), "green").save(animated, format="GIF")
        animated.seek(0)
        response = self.client.post("/api/uploads", headers=self.headers,
            data={"file": (animated, "animated.gif")})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post("/api/uploads",
            data={"file": (image_bytes(), "file.png")}).status_code, 403)
        self.assertEqual(self.app.test_client().post("/api/uploads").status_code, 401)
        self.assertEqual(self.client.post("/api/players", headers=self.headers, json={
            "name": "Player", "photo_path": self.path, "position": "N/A",
        }).status_code, 400)
        self.assertEqual(self.client.post("/api/teams", headers=self.headers, json={
            "name": "Team", "logo_path": "../../private.env",
        }).status_code, 400)
        self.assertEqual(self.client.get("/api/media/private.env").status_code, 404)

    def test_opt_in_sample_seed_refuses_existing_records(self):
        result = self.app.test_cli_runner().invoke(args=["seed-demo", "--yes"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(Team.query.count(), 5)
        self.assertEqual(Player.query.count(), 12)
        self.assertEqual(self.state()["squad_size"], 2)
        before = self.state()
        result = self.app.test_cli_runner().invoke(args=["seed-demo", "--yes"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Existing data was not changed", result.output)
        self.assertEqual(self.state(), before)

    def test_undo_stack_and_setup_conflict_do_not_overwrite_profiles(self):
        state = self.setup_profiles()
        self.start()
        self.action("random")
        self.action("bid", team_id=state["teams"][0]["id"])
        self.action("undo")
        self.assertEqual(self.state()["current"]["bid"], 0)
        self.action("undo")
        self.assertIsNone(self.state()["current"])
        self.action("undo")
        self.assertIsNone(self.state()["open_set"])
        self.action("undo")
        self.assertEqual(self.state()["status"], "setup")
        team_id = state["teams"][0]["id"]
        self.assertEqual(self.client.put(f"/api/teams/{team_id}", headers=self.headers,
            json={"name": "Corrected profile", "logo_path": self.path}).status_code, 200)
        self.assertFalse(self.state()["can_undo"])
        self.action("undo", status=409)
        self.assertEqual(self.state()["teams"][0]["name"], "Corrected profile")

    def test_captain_rules_and_budget(self):
        state = self.setup_profiles(squad_size=3)
        team, other = state["teams"][0]["id"], state["teams"][1]["id"]
        captain = next(p for p in self.state()["players"] if p["team_id"] == team and p["captain"])
        spare = state["players"][0]["id"]
        self.action("captain", status=400, team_id=team, player_id=spare, price=15)
        self.action("captain", status=400, team_id=team, player_id=spare, price=0)
        # Squad of 4 (captain + 3): limit is 1000 - 3 * 10 = 970.
        self.action("captain", status=409, team_id=team, player_id=spare, price=980)
        self.action("captain", status=409, team_id=other, player_id=captain["id"], price=10)
        self.action("captain", team_id=team, player_id=spare, price=970)
        row = next(t for t in self.state()["teams"] if t["id"] == team)
        self.assertEqual((row["budget"], row["max_bid"], row["remaining_slots"]), (30, 10, 3))
        self.action("configure", status=409, squad_size=5)
        self.action("remove_captain", team_id=team)
        self.action("start", status=409)
        self.action("captain", team_id=team, player_id=captain["id"], price=10)
        self.start()
        self.action("captain", status=409, team_id=team, player_id=spare, price=10)
        players = self.state()["players"]
        self.assertTrue(all(p["status"] == "sold" for p in players if p["captain"]))

    def test_sets_limit_selection_and_unsold_set(self):
        state = self.setup_profiles(squad_size=1, extras=2)
        self.action("start")
        pid = state["players"][0]["id"]
        self.action("select", status=409, player_id=pid)
        self.action("open_set", status=400, set_name="BENCH")
        self.action("open_set", set_name="GK")
        # GK captains are not auctioned, so the GK set is empty.
        self.action("random", status=409)
        self.action("select", status=409, player_id=pid)
        self.action("open_set", set_name="MID")
        self.action("select", player_id=pid)
        self.action("close_set", status=409)
        self.action("open_set", status=409, set_name="GK")
        teams = state["teams"]
        self.action("bid", team_id=teams[0]["id"])
        self.action("bid", team_id=teams[1]["id"])
        self.action("bid", team_id=teams[0]["id"])
        self.action("undo")
        self.action("sold")
        sold = next(p for p in self.state()["players"] if p["id"] == pid)
        self.assertEqual(sold["bids"], [{"team_id": teams[0]["id"], "amount": 10},
                                        {"team_id": teams[1]["id"], "amount": 20}])
        second = state["players"][1]["id"]
        self.action("select", player_id=second)
        self.action("unsold")
        self.action("select", status=409, player_id=second)
        self.action("open_set", set_name="UNSOLD")
        self.action("select", player_id=second)
        self.action("close_set", status=409)
        self.action("unsold")
        self.action("close_set")
        self.assertIsNone(self.state()["open_set"])

    def test_return_to_setup_keeps_profiles_and_refuses_after_sales(self):
        state = self.setup_profiles()
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        self.action("bid", team_id=state["teams"][0]["id"])
        self.app.config["BACKUP_FOLDER"] = self.folder.name
        runner = self.app.test_cli_runner()
        result = runner.invoke(args=["return-to-setup", "--yes"])
        self.assertEqual(result.exit_code, 0, result.output)
        after = self.state()
        self.assertEqual(after["status"], "setup")
        self.assertIsNone(after["current"])
        self.assertEqual(after["squad_size"], 2)
        self.assertEqual(sum(p["captain"] for p in after["players"]), 5)
        self.assertFalse(after["can_undo"])
        self.action("undo", status=409)
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        self.action("bid", team_id=state["teams"][0]["id"])
        self.action("sold")
        before = self.state()
        result = runner.invoke(args=["return-to-setup", "--yes"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Nothing changed", result.output)
        self.assertEqual(self.state(), before)

    def test_reset_auction_backs_up_and_clears_progress_but_keeps_profiles(self):
        state = self.setup_profiles()
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        self.action("bid", team_id=state["teams"][0]["id"])
        self.action("sold")
        before = self.state()
        self.app.config["BACKUP_FOLDER"] = self.folder.name
        runner = self.app.test_cli_runner()
        refused = runner.invoke(args=["reset-auction"], input="n\n")
        self.assertNotEqual(refused.exit_code, 0)
        self.assertEqual(self.state(), before)
        result = runner.invoke(args=["reset-auction", "--yes"])
        self.assertEqual(result.exit_code, 0, result.output)
        after = self.state()
        self.assertEqual(after["status"], "setup")
        self.assertEqual(after["squad_size"], 1)
        self.assertIsNone(after["open_set"])
        self.assertIsNone(after["current"])
        self.assertGreater(after["version"], before["version"])
        self.assertEqual([t["id"] for t in after["teams"]], [t["id"] for t in before["teams"]])
        self.assertEqual({p["id"] for p in after["players"]}, {p["id"] for p in before["players"]})
        self.assertTrue(all(p["status"] == "available" and not p["captain"] and not p["bids"] for p in after["players"]))
        self.assertTrue(all(t["budget"] == 1000 and not t["roster"] for t in after["teams"]))
        self.assertFalse(after["can_undo"])
        self.action("undo", status=409)
        backups = list(Path(self.folder.name).glob("auction-before-reset-*.json"))
        self.assertEqual(len(backups), 1)
        saved = json.loads(backups[0].read_text(encoding="utf-8"))
        self.assertEqual(len(saved["state"]["sales"]), 1)
        self.assertGreater(len(saved["events"]), 5)
        with self.app.app_context():
            events = db.session.scalars(select(AuctionEvent)).all()
            self.assertEqual([e.action for e in events], ["maintenance"])

    def test_host_can_delete_started_auction_keeping_profiles_squad_and_captains(self):
        state = self.setup_profiles(squad_size=2)
        self.app.config["BACKUP_FOLDER"] = self.folder.name
        url = "/api/auction/delete-auction"
        version = self.state()["version"]
        refused = self.client.post(url, headers=self.headers, json={"confirm": "DELETE", "expected_version": version})
        self.assertEqual(refused.status_code, 409)
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        self.action("bid", team_id=state["teams"][0]["id"])
        self.action("sold")
        self.action("select", player_id=state["players"][1]["id"])
        self.action("unsold")
        before = self.state()
        anonymous = self.app.test_client()
        self.assertEqual(anonymous.post(url, json={"confirm": "DELETE", "expected_version": before["version"]}).status_code, 401)
        self.assertEqual(self.client.post(url, json={"confirm": "DELETE", "expected_version": before["version"]}).status_code, 403)
        self.assertEqual(self.client.post(url, headers=self.headers, json={"confirm": "delete", "expected_version": before["version"]}).status_code, 400)
        self.assertEqual(self.client.post(url, headers=self.headers, json={"confirm": "DELETE", "expected_version": before["version"] - 1}).status_code, 409)
        self.assertEqual(self.state(), before)
        response = self.client.post(url, headers=self.headers, json={"confirm": "DELETE", "expected_version": before["version"]})
        self.assertEqual(response.status_code, 200, response.json)
        after = self.state()
        self.assertEqual(after["status"], "setup")
        self.assertEqual(after["squad_size"], before["squad_size"])
        self.assertIsNone(after["current"])
        self.assertIsNone(after["open_set"])
        self.assertEqual(sum(p["captain"] for p in after["players"]), 5)
        self.assertEqual({p["id"] for p in after["players"]}, {p["id"] for p in before["players"]})
        self.assertTrue(all(p["status"] == "available" and not p["bids"] for p in after["players"] if not p["captain"]))
        self.assertTrue(all(len(t["roster"]) == 1 for t in after["teams"]))
        self.assertFalse(after["can_undo"])
        self.assertEqual(len(list(Path(self.folder.name).glob("auction-before-delete-auction-*.json"))), 1)
        self.start()

    def test_host_can_download_a_full_backup(self):
        state = self.setup_profiles()
        self.start()
        self.action("select", player_id=state["players"][0]["id"])
        self.action("bid", team_id=state["teams"][0]["id"])
        self.assertEqual(self.app.test_client().get("/api/auction/backup").status_code, 401)
        response = self.client.get("/api/auction/backup")
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment; filename=\"venomsfc-auction-backup-", response.headers["Content-Disposition"])
        data = response.get_json()
        self.assertEqual(data["kind"], "venomsfc-auction-backup")
        self.assertEqual(data["version"], self.state()["version"])
        self.assertEqual(len(data["snapshot"]["teams"]), 5)
        self.assertEqual(data["events"][-1]["action"], "bid")


if __name__ == "__main__":
    unittest.main()
