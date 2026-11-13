import unittest
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image
from sqlalchemy import event, select
from werkzeug.security import generate_password_hash

from app import create_app
from cup_rules import build_league_fixtures
from extensions import db
from models import (
    Auction,
    AuctionEvent,
    CupAudit,
    CupHostSession,
    CupMatch,
    CupMatchEvent,
    CupParticipation,
    CupPlayer,
    CupRosterMembership,
    CupTeam,
    CupTournament,
    Player,
    Team,
)


class CupApiTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "SECRET_KEY": "cup-test-key",
            "HOST_PASSWORD_HASH": generate_password_hash("test-host-password"),
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
        })
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        self.client = self.app.test_client()
        self.teams = [
            Team(name=f"Team {index}", logo_path=f"teams/{index}.png")
            for index in range(1, 6)
        ]
        self.players = [
            Player(name=f"Player {index}", photo_path=f"players/{index}.jpg", position="GK")
            for index in range(1, 11)
        ]
        db.session.add_all([*self.teams, *self.players])
        db.session.flush()
        db.session.add_all([
            CupTeam(id=team.id, auction_team_id=team.id, name=team.name, logo_path=team.logo_path)
            for team in self.teams
        ] + [
            CupPlayer(id=player.id, auction_player_id=player.id, name=player.name,
                      photo_path=player.photo_path, position=player.position, active=True)
            for player in self.players
        ])
        assignments = {
            str(player.id): {"team_id": self.teams[index // 2].id, "price": 10}
            for index, player in enumerate(self.players)
        }
        db.session.add(Auction(
            id=1, version=7,
            state={"status": "completed", "sales": assignments, "captains": {}},
        ))
        db.session.add(AuctionEvent(
            request_id="old-auction-event", payload={}, action="sold",
            before={}, after={}, version=7, undone=False,
            created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        self.auction_state = db.session.get(Auction, 1).state.copy()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
        self.context.pop()

    def login(self):
        session = self.client.get("/api/cup-auth/session").json
        response = self.client.post(
            "/api/cup-auth/login",
            headers={"X-CSRF-Token": session["csrf_token"]},
            json={"password": "test-host-password"},
        )
        self.assertEqual(response.status_code, 200, response.json)
        return response.json["csrf_token"]

    def post(self, path, csrf, body):
        return self.client.post(path, headers={"X-CSRF-Token": csrf}, json=body)

    def test_host_mutations_require_authentication_and_csrf(self):
        response = self.client.post("/api/cup/host/tournaments", json={
            "request_id": "create-unauth",
        })
        self.assertEqual(response.status_code, 401)
        csrf = self.login()
        response = self.client.post("/api/cup/host/tournaments", json={
            "request_id": "create-no-csrf",
        })
        self.assertEqual(response.status_code, 403)

    def test_tournament_and_auction_sessions_are_independent(self):
        auction = self.client.get("/api/auth/session").json
        signed_in = self.client.post(
            "/api/auth/login", headers={"X-CSRF-Token": auction["csrf_token"]},
            json={"password": "test-host-password"},
        )
        self.assertEqual(signed_in.status_code, 200)
        auction_csrf = signed_in.json["csrf_token"]
        self.assertFalse(self.client.get("/api/cup-auth/session").json["authenticated"])

        cup_csrf = self.login()
        self.assertTrue(self.client.get("/api/auth/session").json["authenticated"])
        self.assertEqual(self.client.post(
            "/api/cup/host/tournaments", headers={"X-CSRF-Token": auction_csrf},
            json={"request_id": "wrong-domain-csrf"},
        ).status_code, 403)
        self.assertEqual(self.client.post(
            "/api/cup-auth/logout", headers={"X-CSRF-Token": cup_csrf},
        ).status_code, 200)
        self.assertTrue(self.client.get("/api/auth/session").json["authenticated"])
        self.assertFalse(self.client.get("/api/cup-auth/session").json["authenticated"])

        cup_csrf = self.login()
        self.assertEqual(self.client.post(
            "/api/auth/logout", headers={"X-CSRF-Token": auction_csrf},
        ).status_code, 200)
        self.assertTrue(self.client.get("/api/cup-auth/session").json["authenticated"])
        self.assertEqual(self.client.post(
            "/api/cup/host/tournaments", headers={"X-CSRF-Token": cup_csrf},
            json={"request_id": "independent-cup-create"},
        ).status_code, 201)

    def test_expired_tournament_session_does_not_change_auction_session(self):
        auction = self.client.get("/api/auth/session").json
        self.client.post(
            "/api/auth/login", headers={"X-CSRF-Token": auction["csrf_token"]},
            json={"password": "test-host-password"},
        )
        self.login()
        cup_session = db.session.scalar(select(CupHostSession))
        cup_session.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()
        self.assertFalse(self.client.get("/api/cup-auth/session").json["authenticated"])
        self.assertTrue(self.client.get("/api/auth/session").json["authenticated"])
        self.assertEqual(self.client.get("/api/cup/host/requests/expired-request").status_code, 401)

    def test_request_status_is_authorized_and_serialized_with_host_commands(self):
        unauthorized = self.client.get("/api/cup/host/requests/request-not-committed-001")
        self.assertEqual(unauthorized.status_code, 401)
        csrf = self.login()
        missing = self.client.get("/api/cup/host/requests/request-not-committed-001")
        self.assertEqual(missing.status_code, 200)
        self.assertEqual(missing.json["status"], "not_committed")

        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "request-status-created-001",
        })
        self.assertEqual(created.status_code, 201)
        receipt = self.client.get(
            "/api/cup/host/requests/request-status-created-001"
        )
        self.assertEqual(receipt.status_code, 200, receipt.json)
        self.assertEqual(receipt.json["status"], "committed")
        self.assertEqual(receipt.json["resource"], "/api/cup/host/tournaments")
        self.assertEqual(receipt.json["tournament_id"], created.json["tournament_id"])
        self.assertNotIn("payload", receipt.json)

    def test_request_cancellation_tombstone_rejects_a_late_original_post(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-cancel-race",
        })
        tournament_id = created.json["tournament_id"]
        request_id = "late-settings-request"
        self.assertEqual(self.client.get(
            f"/api/cup/host/requests/{request_id}"
        ).json["status"], "not_committed")

        canceled = self.post(f"/api/cup/host/requests/{request_id}/cancel", csrf, {
            "request_id": request_id, "tournament_id": tournament_id,
        })
        self.assertEqual(canceled.status_code, 200, canceled.json)
        self.assertEqual(canceled.json["status"], "cancelled")
        self.assertEqual(self.client.get(
            f"/api/cup/host/requests/{request_id}"
        ).json["status"], "cancelled")
        cancellation_history = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"]
        self.assertNotIn("request_cancelled", [row["action"] for row in cancellation_history])

        late_original = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": request_id, "expected_version": 0,
            "settings": {"players_per_side": 4},
        })
        self.assertEqual(late_original.status_code, 409, late_original.json)
        self.assertIn("already used", late_original.json["error"])
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(detail["version"], 0)

        repeated_cancel = self.post(f"/api/cup/host/requests/{request_id}/cancel", csrf, {
            "request_id": request_id, "tournament_id": tournament_id,
        })
        self.assertEqual(repeated_cancel.status_code, 200, repeated_cancel.json)
        self.assertEqual(repeated_cancel.json["status"], "cancelled")

        committed_id = "already-committed-settings"
        committed = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": committed_id, "expected_version": detail["version"],
            "settings": {"players_per_side": 4},
        })
        self.assertEqual(committed.status_code, 200, committed.json)
        late_cancel = self.post(f"/api/cup/host/requests/{committed_id}/cancel", csrf, {
            "request_id": committed_id, "tournament_id": tournament_id,
        })
        self.assertEqual(late_cancel.status_code, 200, late_cancel.json)
        self.assertEqual(late_cancel.json["status"], "committed")
        self.assertEqual(late_cancel.json["action"], "settings_update")
        self.assertEqual(self.client.get(
            f"/api/cup/host/requests/{committed_id}"
        ).json["status"], "committed")
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        self.assertIn("settings_update", [row["action"] for row in history])
        self.assertNotIn("request_cancelled", [row["action"] for row in history])

    def test_captain_mapping_uses_auction_identity_and_current_roster(self):
        auction = db.session.get(Auction, 1)
        auction.state = {**auction.state, "captains": {
            str(self.teams[0].id): {"player_id": self.players[0].id, "price": 10},
        }}
        original = dict(auction.state)
        db.session.get(CupPlayer, self.players[0].id).auction_player_id = None
        db.session.add(CupPlayer(
            id=101, auction_player_id=self.players[0].id, name="Cup captain",
            photo_path="players/1.jpg", position="GK", active=True,
        ))
        db.session.commit()
        csrf = self.login()
        tournament_id = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-captain-test",
        }).json["tournament_id"]
        response = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-captain-test", "expected_version": 0,
        })
        self.assertEqual(response.status_code, 200, response.json)
        team = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["teams"][0]
        self.assertEqual(team["captain_player_id"], 101)
        self.assertEqual(self.client.get(f"/api/cup/teams/{team['id']}").json["team"]["captain_player_id"], 101)
        membership = db.session.scalar(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id, CupRosterMembership.player_id == 101,
        ))
        membership.team_id = self.teams[1].id
        db.session.commit()
        teams = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["teams"]
        self.assertTrue(all(row["captain_player_id"] is None for row in teams))
        self.assertEqual(db.session.get(Auction, 1).state, original)

    def test_all_supported_player_leaderboards_are_ranked_and_ignore_voided_events(self):
        now = datetime.now(timezone.utc)
        tournament = CupTournament(name="Cup", edition="Test", lifecycle="running", settings={}, created_at=now)
        db.session.add(tournament)
        db.session.flush()
        match = CupMatch(tournament_id=tournament.id, stage="league", home_team_id=1,
                         away_team_id=2, match_order=1, state="live", settings={}, clock={})
        db.session.add(match)
        db.session.flush()
        db.session.add_all([
            CupParticipation(match_id=match.id, team_id=1, player_id=player_id,
                             status="starter", goalkeeper=False)
            for player_id in (1, 2)
        ])
        for index, (player_id, event_type, outcome, payload, voided) in enumerate([
            (1, "shot", "goal", {}, False),
            (2, "shot", "saved", {}, False),
            (2, "shot", "off_target", {}, False),
            (1, "yellow_card", None, {"second_yellow_dismissal": True}, False),
            (1, "own_goal", None, {}, False),
            (1, "shot", "goal", {}, True),
        ]):
            db.session.add(CupMatchEvent(
                match_id=match.id, request_id=f"ranking-event-{index}", event_type=event_type,
                minute=index, period="first_half", team_id=1, player_id=player_id,
                outcome=outcome, payload=payload, voided=voided, created_at=now,
            ))
        db.session.commit()
        boards = self.client.get(f"/api/cup/{tournament.id}").json["tournament"]["leaderboards"]
        self.assertEqual([row["player"]["id"] for row in boards["shots"]], [2, 1])
        self.assertEqual([row["total"] for row in boards["shots"]], [2, 1])
        self.assertEqual([row["rank"] for row in boards["appearances"]], [1, 1])
        self.assertEqual(boards["goals"][0]["total"], 1)
        for key in ("yellow_cards", "red_cards", "second_yellow_reds", "own_goals"):
            self.assertEqual(boards[key][0]["total"], 1)
        self.assertEqual(boards["saves"], [])

    def test_import_can_be_undone_and_reapplied_without_reusing_history(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-import-retry",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-retry-first", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        first_ids = [row.id for row in db.session.scalars(select(CupRosterMembership)).all()]
        audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={audit_id}"
        ).json
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-import-first", "target_audit_id": audit_id,
            "expected_version": preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        self.assertFalse(any(row.active for row in db.session.scalars(
            select(CupRosterMembership).where(
                CupRosterMembership.tournament_id == tournament_id
            )
        ).all()))

        reapplied = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-retry-second", "expected_version": undone.json["version"],
        })
        self.assertEqual(reapplied.status_code, 200, reapplied.json)
        memberships = db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id
        ).order_by(CupRosterMembership.id)).all()
        self.assertEqual(len(memberships), 2 * len(self.players))
        self.assertEqual({row.active for row in memberships}, {False, True})
        self.assertEqual({row.id for row in memberships if not row.active}, set(first_ids))

    def test_setup_import_schedule_scoring_and_undo_preserve_auction(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-cup-0001", "name": "Venoms Internal Cup", "edition": "Test",
        })
        self.assertEqual(created.status_code, 201, created.json)
        tournament_id = created.json["tournament_id"]
        replay = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-cup-0001", "name": "Venoms Internal Cup", "edition": "Test",
        })
        self.assertEqual(replay.json, created.json)

        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-cup-0001", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        self.assertEqual(imported.json["version"], 1)
        replayed_import = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-cup-0001", "expected_version": 0,
        })
        self.assertEqual(replayed_import.status_code, 200)
        self.assertEqual(replayed_import.json, imported.json)
        changed_replay = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-cup-0001", "expected_version": 1,
        })
        self.assertEqual(changed_replay.status_code, 409)

        second_tournament = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-cup-second",
        })
        self.assertEqual(second_tournament.status_code, 201)
        cross_resource_replay = self.post(
            f"/api/cup/host/{second_tournament.json['tournament_id']}/import-squads",
            csrf, {"request_id": "import-cup-0001", "expected_version": 0},
        )
        self.assertEqual(cross_resource_replay.status_code, 409)

        settings = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": "settings-cup-01", "expected_version": 1,
            "settings": {"players_per_side": 2, "half_minutes": 1, "break_minutes": 0,
                         "between_match_rest_minutes": 0, "playoff_rest_minutes": 1},
        })
        self.assertEqual(settings.status_code, 200, settings.json)
        fixtures = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-cup-001", "expected_version": 2,
            "kickoff": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
        })
        self.assertEqual(fixtures.status_code, 200, fixtures.json)
        published = self.post(f"/api/cup/host/{tournament_id}/publish", csrf, {
            "request_id": "publish-cup-001", "expected_version": 3,
        })
        self.assertEqual(published.status_code, 200, published.json)
        started = self.post(f"/api/cup/host/{tournament_id}/start", csrf, {
            "request_id": "start-cup-0001", "expected_version": 4,
        })
        self.assertEqual(started.status_code, 200, started.json)

        extra_player = CupPlayer(
            id=11, name="Player 11", photo_path="players/11.jpg", position="DEF", active=True,
        )
        db.session.add(extra_player)
        db.session.flush()
        db.session.add(CupRosterMembership(
            tournament_id=tournament_id, team_id=self.teams[0].id,
            player_id=extra_player.id, active=True, created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(len(detail["matches"]), 10)
        self.assertEqual(len(detail["standings"]), 5)
        self.assertEqual(
            {team["id"]: sum(team["id"] in (match["home_team_id"], match["away_team_id"])
                             for match in detail["matches"]) for team in detail["teams"]},
            {team["id"]: 4 for team in detail["teams"]},
        )
        for previous, current in zip(detail["matches"], detail["matches"][1:]):
            self.assertFalse(
                {previous["home_team_id"], previous["away_team_id"]}
                & {current["home_team_id"], current["away_team_id"]}
            )

        match = detail["matches"][0]
        home_players = [player for team in detail["teams"] if team["id"] == match["home_team_id"]
                        for player in team["players"]]
        away_players = [player for team in detail["teams"] if team["id"] == match["away_team_id"]
                        for player in team["players"]]
        lineup = self.post(f"/api/cup/host/matches/{match['id']}/lineup", csrf, {
            "request_id": "lineup-cup-001", "expected_version": 5, "expected_match_version": 0,
            "players": [
                {"player_id": home_players[0]["id"], "team_id": match["home_team_id"],
                 "status": "starter", "goalkeeper": True},
                {"player_id": home_players[1]["id"], "team_id": match["home_team_id"],
                 "status": "starter", "goalkeeper": False},
                {"player_id": away_players[0]["id"], "team_id": match["away_team_id"],
                 "status": "starter", "goalkeeper": True},
                {"player_id": away_players[1]["id"], "team_id": match["away_team_id"],
                 "status": "starter", "goalkeeper": False},
                {"player_id": home_players[2]["id"], "team_id": match["home_team_id"],
                 "status": "bench", "goalkeeper": False},
            ],
        })
        self.assertEqual(lineup.status_code, 200, lineup.json)
        scheduled_profile = self.client.get(
            f"/api/cup/players/{home_players[0]['id']}"
        ).json["player"]
        self.assertEqual(scheduled_profile["statistics"]["appearances"], 0)
        kickoff = self.post(f"/api/cup/host/matches/{match['id']}/clock", csrf, {
            "request_id": "kickoff-cup-01", "expected_version": 6,
            "expected_match_version": 1, "command": "kickoff",
        })
        self.assertEqual(kickoff.status_code, 200, kickoff.json)
        wrong_period = self.post(f"/api/cup/host/matches/{match['id']}/events", csrf, {
            "request_id": "wrong-period", "expected_version": 7,
            "expected_match_version": 2, "event_type": "shot", "outcome": "goal",
            "period": "second_half", "minute": 1, "team_id": match["home_team_id"],
            "player_id": home_players[0]["id"],
        })
        self.assertEqual(wrong_period.status_code, 400, wrong_period.json)
        goal = self.post(f"/api/cup/host/matches/{match['id']}/events", csrf, {
            "request_id": "goal-cup-0001", "expected_version": 7,
            "expected_match_version": 2, "event_type": "shot", "outcome": "goal",
            "period": "first_half", "minute": 1, "team_id": match["home_team_id"],
            "player_id": home_players[0]["id"],
        })
        self.assertEqual(goal.status_code, 200, goal.json)
        save = self.post(f"/api/cup/host/matches/{match['id']}/events", csrf, {
            "request_id": "save-cup-0001", "expected_version": 8,
            "expected_match_version": 3, "event_type": "shot", "outcome": "saved",
            "period": "first_half", "minute": 1, "team_id": match["away_team_id"],
            "player_id": away_players[0]["id"], "goalkeeper_id": home_players[0]["id"],
        })
        self.assertEqual(save.status_code, 200, save.json)
        current = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        score = current["matches"][0]
        self.assertEqual((score["home_goals"], score["away_goals"]), (1, 0))
        self.assertEqual(current["leaderboards"]["goals"][0]["total"], 1)
        self.assertEqual(current["leaderboards"]["goals"][0]["appearances"], 1)
        self.assertEqual(current["leaderboards"]["saves"][0]["total"], 1)
        self.assertEqual([row["total"] for row in current["leaderboards"]["shots"]], [1, 1])
        self.assertEqual(len(current["leaderboards"]["appearances"]), 4)
        self.assertEqual(current["leaderboards"]["yellow_cards"], [])
        shooter_profile = self.client.get(
            f"/api/cup/players/{home_players[0]['id']}"
        ).json["player"]
        self.assertEqual(shooter_profile["statistics"]["goals"], 1)
        self.assertEqual(shooter_profile["statistics"]["shots"], 1)
        self.assertEqual([row["id"] for row in shooter_profile["matches"]], [match["id"]])
        keeper_profile = self.client.get(
            f"/api/cup/players/{home_players[0]['id']}"
        ).json["player"]
        self.assertEqual(keeper_profile["statistics"]["saves"], 1)

        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        last_action = history[-1]
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={last_action['id']}"
        ).json
        undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-save-0001", "target_audit_id": last_action["id"],
            "expected_version": preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undo.status_code, 200, undo.json)
        after_undo = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(after_undo["leaderboards"]["saves"], [])
        self.assertEqual(after_undo["matches"][0]["home_goals"], 1)

        substitution = self.post(f"/api/cup/host/matches/{match['id']}/events", csrf, {
            "request_id": "substitute-01", "expected_version": 10,
            "expected_match_version": 5, "event_type": "substitution",
            "period": "first_half", "minute": 2, "team_id": match["home_team_id"],
            "player_id": home_players[0]["id"], "incoming_player_id": home_players[2]["id"],
        })
        self.assertEqual(substitution.status_code, 200, substitution.json)
        old_keeper = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[0]["id"],
        ))
        new_keeper = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[2]["id"],
        ))
        self.assertFalse(old_keeper.goalkeeper)
        self.assertTrue(new_keeper.goalkeeper)
        change_keeper = self.post(f"/api/cup/host/matches/{match['id']}/goalkeeper", csrf, {
            "request_id": "keeper-change-01", "expected_version": 11,
            "expected_match_version": 6, "team_id": match["home_team_id"],
            "player_id": home_players[1]["id"],
        })
        self.assertEqual(change_keeper.status_code, 200, change_keeper.json)
        self.assertTrue(db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[1]["id"],
        )).goalkeeper)
        keeper_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        keeper_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={keeper_audit_id}"
        ).json
        undone_keeper = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-keeper-change", "target_audit_id": keeper_audit_id,
            "expected_version": keeper_preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone_keeper.status_code, 200, undone_keeper.json)
        self.assertFalse(db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[1]["id"],
        )).goalkeeper)
        self.assertTrue(new_keeper.goalkeeper)
        first_yellow = self.post(f"/api/cup/host/matches/{match['id']}/events", csrf, {
            "request_id": "yellow-card-1", "expected_version": 13,
            "expected_match_version": 8, "event_type": "yellow_card",
            "period": "first_half", "minute": 3, "team_id": match["home_team_id"],
            "player_id": home_players[2]["id"],
        })
        self.assertEqual(first_yellow.status_code, 200, first_yellow.json)
        second_yellow = self.post(f"/api/cup/host/matches/{match['id']}/events", csrf, {
            "request_id": "yellow-card-2", "expected_version": 14,
            "expected_match_version": 9, "event_type": "yellow_card",
            "period": "first_half", "minute": 4, "team_id": match["home_team_id"],
            "player_id": home_players[2]["id"],
            "replacement_goalkeeper_id": home_players[1]["id"],
        })
        self.assertEqual(second_yellow.status_code, 200, second_yellow.json)
        substituted = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[2]["id"],
        ))
        self.assertEqual(substituted.status, "dismissed")
        dismissed_profile = self.client.get(
            f"/api/cup/players/{home_players[2]['id']}"
        ).json["player"]
        self.assertEqual(dismissed_profile["statistics"]["yellow_cards"], 2)
        self.assertEqual(dismissed_profile["statistics"]["red_cards"], 1)
        self.assertEqual(dismissed_profile["statistics"]["second_yellow_reds"], 1)
        card_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        card_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={card_audit_id}"
        ).json
        undone_card = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-yellow-2", "target_audit_id": card_audit_id,
            "expected_version": card_preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone_card.status_code, 200, undone_card.json)
        self.assertEqual(substituted.status, "entered")
        undo_record_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        undo_record_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={undo_record_id}"
        ).json
        self.assertIsNone(undo_record_preview["target"])
        undo_record_attempt = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-undo-record", "target_audit_id": undo_record_id,
            "expected_version": self.client.get(
                f"/api/cup/{tournament_id}"
            ).json["tournament"]["version"],
            "cascade": False,
        })
        self.assertEqual(undo_record_attempt.status_code, 409)
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        substitution_audit_id = next(
            row["id"] for row in history
            if row["details"].get("event_type") == "substitution"
        )
        cascade_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={substitution_audit_id}"
        ).json
        self.assertEqual(
            [(row["action"], row["id"]) for row in cascade_preview["affected"]],
            [("match_event", next(
                row["id"] for row in history
                if row["details"].get("event_type") == "yellow_card"
                and row["id"] != card_audit_id
            ))],
        )
        rejected_cascade = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "reject-cascade", "target_audit_id": substitution_audit_id,
            "expected_version": cascade_preview["expected_version"], "cascade": False,
        })
        self.assertEqual(rejected_cascade.status_code, 409, rejected_cascade.json)
        cascaded = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-substitution", "target_audit_id": substitution_audit_id,
            "expected_version": cascade_preview["expected_version"], "cascade": True,
        })
        self.assertEqual(cascaded.status_code, 200, cascaded.json)
        starter = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[0]["id"],
        ))
        bench = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match["id"],
            CupParticipation.player_id == home_players[2]["id"],
        ))
        self.assertEqual((starter.status, bench.status), ("starter", "bench"))
        active_cards = db.session.scalars(select(CupMatchEvent).where(
            CupMatchEvent.match_id == match["id"],
            CupMatchEvent.event_type == "yellow_card",
            CupMatchEvent.voided.is_(False),
        )).all()
        self.assertEqual(active_cards, [])

        auction = db.session.get(Auction, 1)
        self.assertEqual(auction.version, 7)
        self.assertEqual(auction.state, self.auction_state)
        self.assertEqual(db.session.query(AuctionEvent).count(), 1)

    def test_invalid_league_schedule_request_does_not_create_fixtures(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-cup-0002",
        })
        tournament_id = created.json["tournament_id"]
        self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-cup-0002", "expected_version": 0,
        })
        self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": "settings-cup-02", "expected_version": 1,
            "settings": {"players_per_side": 1},
        })
        bad = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-invalid", "expected_version": 2,
            "kickoff": "not-a-date",
        })
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(db.session.query(CupMatch).count(), 0)

    def test_roster_move_after_play_preserves_participation_and_guards_lineups(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "create-played-roster"})
        tournament_id = created.json["tournament_id"]
        self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-played-roster", "expected_version": 0,
        })
        cup = db.session.get(CupTournament, tournament_id)
        cup.lifecycle = "running"
        match = CupMatch(
            tournament_id=tournament_id, stage="league", home_team_id=self.teams[0].id,
            away_team_id=self.teams[1].id, match_order=1, state="live",
            settings={}, version=0, clock={},
        )
        db.session.add(match)
        db.session.flush()
        participation = CupParticipation(
            match_id=match.id, team_id=self.teams[0].id, player_id=self.players[0].id,
            status="starter", goalkeeper=True,
        )
        db.session.add(participation)
        db.session.commit()
        payload = {
            "request_id": "move-player-live", "expected_version": 1,
            "player_id": self.players[0].id, "team_id": self.teams[1].id,
        }
        rejected = self.post(f"/api/cup/host/{tournament_id}/rosters", csrf, payload)
        self.assertEqual(rejected.status_code, 409)
        match.state = "finalized"
        db.session.commit()
        payload["request_id"] = "move-player-played"
        moved = self.post(f"/api/cup/host/{tournament_id}/rosters", csrf, payload)
        self.assertEqual(moved.status_code, 200, moved.json)
        self.assertEqual(participation.team_id, self.teams[0].id)
        self.assertEqual(db.session.get(Auction, 1).state, self.auction_state)

    def test_tournament_profiles_and_new_players_are_audited_and_isolated(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "create-profile-cup"})
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-profile-cup", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200)
        player_name = self.players[0].name
        edited = self.post(f"/api/cup/host/{tournament_id}/profiles", csrf, {
            "request_id": "edit-cup-player", "expected_version": 1,
            "entity": "player", "id": self.players[0].id, "name": "Cup name",
            "position": "MID",
        })
        self.assertEqual(edited.status_code, 200, edited.json)
        self.assertEqual(db.session.get(Player, self.players[0].id).name, player_name)
        self.assertEqual(db.session.get(CupPlayer, self.players[0].id).name, "Cup name")
        added = self.post(f"/api/cup/host/{tournament_id}/profiles", csrf, {
            "request_id": "add-cup-player", "expected_version": 2,
            "entity": "player", "id": None, "name": "New Cup Player",
            "position": "DEF", "photo_path": "",
        })
        self.assertEqual(added.status_code, 200, added.json)
        new_player = db.session.scalar(select(CupPlayer).where(CupPlayer.name == "New Cup Player"))
        self.assertIsNone(new_player.auction_player_id)
        self.assertEqual(db.session.query(Player).count(), 10)
        audit_id = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"][-1]["id"]
        assigned = self.post(f"/api/cup/host/{tournament_id}/rosters", csrf, {
            "request_id": "assign-new-cup-player", "expected_version": 3,
            "player_id": new_player.id, "team_id": self.teams[0].id,
        })
        self.assertEqual(assigned.status_code, 200, assigned.json)
        self.assertIn("New Cup Player", [
            row["name"] for row in self.client.get(
                f"/api/cup/teams/{self.teams[0].id}"
            ).json["team"]["players"]
        ])
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={audit_id}"
        ).json
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-cup-player", "target_audit_id": audit_id,
            "expected_version": preview["expected_version"], "cascade": True,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        self.assertFalse(new_player.active)
        self.assertNotIn("New Cup Player", [row["name"] for row in self.client.get("/api/cup/players").json["players"]])
        self.assertEqual(db.session.get(Auction, 1).state, self.auction_state)

    def test_roster_move_and_removal_are_audited_and_undoable(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-roster",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-roster", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        player = self.players[0]
        original_team = self.teams[0]
        next_team = self.teams[1]

        moved = self.post(f"/api/cup/host/{tournament_id}/rosters", csrf, {
            "request_id": "move-roster", "expected_version": 1,
            "player_id": player.id, "team_id": next_team.id,
        })
        self.assertEqual(moved.status_code, 200, moved.json)
        active = db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id,
            CupRosterMembership.player_id == player.id,
            CupRosterMembership.active.is_(True),
        )).all()
        self.assertEqual([(row.team_id) for row in active], [next_team.id])

        move_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        move_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={move_audit_id}"
        ).json
        undone_move = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-move", "target_audit_id": move_audit_id,
            "expected_version": move_preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone_move.status_code, 200, undone_move.json)
        active = db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id,
            CupRosterMembership.player_id == player.id,
            CupRosterMembership.active.is_(True),
        )).all()
        self.assertEqual([(row.team_id) for row in active], [original_team.id])

        removed = self.post(f"/api/cup/host/{tournament_id}/rosters", csrf, {
            "request_id": "remove-roster", "expected_version": 3,
            "player_id": player.id, "team_id": None,
        })
        self.assertEqual(removed.status_code, 200, removed.json)
        self.assertFalse(any(row.active for row in db.session.scalars(
            select(CupRosterMembership).where(
                CupRosterMembership.tournament_id == tournament_id,
                CupRosterMembership.player_id == player.id,
            )
        ).all()))

        removal_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        removal_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={removal_audit_id}"
        ).json
        undone_removal = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-remove", "target_audit_id": removal_audit_id,
            "expected_version": removal_preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone_removal.status_code, 200, undone_removal.json)
        active = db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id,
            CupRosterMembership.player_id == player.id,
            CupRosterMembership.active.is_(True),
        )).all()
        self.assertEqual([(row.team_id) for row in active], [original_team.id])
        undo_removal_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        undo_removal_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={undo_removal_id}"
        ).json
        self.assertIsNone(undo_removal_preview["target"])
        rejected_undo_record = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "redo-removal", "target_audit_id": undo_removal_id,
            "expected_version": self.client.get(
                f"/api/cup/{tournament_id}"
            ).json["tournament"]["version"],
            "cascade": False,
        })
        self.assertEqual(rejected_undo_record.status_code, 409)
        auction = db.session.get(Auction, 1)
        self.assertEqual(auction.version, 7)
        self.assertEqual(auction.state, self.auction_state)

    def test_fixture_order_and_schedule_reject_invalid_sequences_and_undo(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-fixture",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-fixture", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        kickoff = datetime.now(timezone.utc)
        generated = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "generate-fixture", "expected_version": 1,
            "kickoff": kickoff.isoformat(),
        })
        self.assertEqual(generated.status_code, 200, generated.json)
        original = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id
        ).order_by(CupMatch.match_order)).all()
        original_ids = [match.id for match in original]
        original_schedule = [match.scheduled_at for match in original]

        invalid = [original_ids[0], original_ids[0], *original_ids[2:]]
        rejected = self.post(f"/api/cup/host/{tournament_id}/fixtures/reorder", csrf, {
            "request_id": "invalid-order", "expected_version": 2,
            "match_ids": invalid, "kickoff": kickoff.isoformat(),
        })
        self.assertEqual(rejected.status_code, 400, rejected.json)
        self.assertEqual([match.match_order for match in original], list(range(1, 11)))

        reversed_ids = list(reversed(original_ids))
        reordered = self.post(f"/api/cup/host/{tournament_id}/fixtures/reorder", csrf, {
            "request_id": "reverse-order", "expected_version": 2,
            "match_ids": reversed_ids, "kickoff": (kickoff + timedelta(hours=1)).isoformat(),
        })
        self.assertEqual(reordered.status_code, 200, reordered.json)
        refreshed = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id
        ).order_by(CupMatch.match_order)).all()
        self.assertEqual([match.id for match in refreshed], reversed_ids)
        self.assertEqual(
            refreshed[0].scheduled_at.replace(tzinfo=timezone.utc),
            kickoff + timedelta(hours=1),
        )
        for previous, current in zip(refreshed, refreshed[1:]):
            self.assertFalse(
                {previous.home_team_id, previous.away_team_id}
                & {current.home_team_id, current.away_team_id}
            )

        audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={audit_id}"
        ).json
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-order", "target_audit_id": audit_id,
            "expected_version": preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        restored = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id
        ).order_by(CupMatch.match_order)).all()
        self.assertEqual([match.id for match in restored], original_ids)
        self.assertEqual([match.scheduled_at for match in restored], original_schedule)

        cup = db.session.get(CupTournament, tournament_id)
        cup.lifecycle = "running"
        restored[0].state = "finalized"
        for match in restored[1:]:
            match.state = "scheduled"
        db.session.commit()
        rejected = self.post(f"/api/cup/host/{tournament_id}/fixtures/reorder", csrf, {
            "request_id": "move-completed-fixture", "expected_version": 4,
            "match_ids": list(reversed(original_ids)), "kickoff": kickoff.isoformat(),
        })
        self.assertEqual(rejected.status_code, 409)
        rescheduled = self.post(f"/api/cup/host/{tournament_id}/fixtures/reorder", csrf, {
            "request_id": "reschedule-future-fixtures", "expected_version": 4,
            "match_ids": original_ids, "kickoff": (kickoff + timedelta(days=1)).isoformat(),
        })
        self.assertEqual(rescheduled.status_code, 200, rescheduled.json)
        self.assertEqual(restored[0].scheduled_at, original_schedule[0])
        self.assertNotEqual(restored[1].scheduled_at, original_schedule[1])
        restored[4].state = "finalized"
        locked = [(row.id, row.match_order, row.scheduled_at, row.version) for row in (restored[0], restored[4])]
        db.session.commit()
        desired = original_ids.copy()
        desired[1], desired[5] = desired[5], desired[1]
        changed = self.post(f"/api/cup/host/{tournament_id}/fixtures/reorder", csrf, {
            "request_id": "move-pending-around-completed", "expected_version": rescheduled.json["version"],
            "match_ids": desired, "kickoff": (kickoff + timedelta(days=2)).isoformat(),
        })
        self.assertEqual(changed.status_code, 200, changed.json)
        self.assertEqual([(row.id, row.match_order, row.scheduled_at, row.version)
                          for row in (restored[0], restored[4])], locked)
        ordered = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id
        ).order_by(CupMatch.match_order)).all()
        self.assertEqual([row.id for row in ordered], desired)
        self.assertTrue({ordered[0].home_team_id, ordered[0].away_team_id}
                        & {ordered[1].home_team_id, ordered[1].away_team_id})
        pending = [row for row in ordered if row.state == "scheduled"]
        gap = timedelta(minutes=(
            cup.settings["half_minutes"] * 2 + cup.settings["break_minutes"]
            + cup.settings["between_match_rest_minutes"]
        ))
        self.assertEqual(pending[0].scheduled_at.replace(tzinfo=timezone.utc), kickoff + timedelta(days=2))
        for left, right in zip(pending, pending[1:]):
            self.assertEqual(right.scheduled_at - left.scheduled_at, gap)
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        target = history[-1]["id"]
        undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-pending-move", "target_audit_id": target,
            "expected_version": changed.json["version"], "cascade": False,
        })
        self.assertEqual(undo.status_code, 200, undo.json)
        self.assertEqual([row.id for row in db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id
        ).order_by(CupMatch.match_order)).all()], original_ids)

    def test_fixture_refresh_batches_match_data_and_offers_a_lightweight_tournament_list(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-batched-refresh",
        })
        tournament_id = created.json["tournament_id"]
        self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-batched-refresh", "expected_version": 0,
        })
        generated = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-batched-refresh", "expected_version": 1,
            "kickoff": "2026-11-14T10:00:00+00:00",
        })
        self.assertEqual(generated.status_code, 200, generated.json)
        first = db.session.scalar(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id, CupMatch.match_order == 1,
        ))
        first.state = "finalized"
        former_player = db.session.get(CupPlayer, self.players[0].id)
        membership = db.session.scalar(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id,
            CupRosterMembership.player_id == former_player.id,
        ))
        membership.active = False
        db.session.add(CupParticipation(
            match_id=first.id, team_id=first.home_team_id, player_id=former_player.id,
            status="starter", goalkeeper=False,
        ))
        db.session.add(CupMatchEvent(
            match_id=first.id, request_id="batched-historical-goal", event_type="shot",
            minute=1, period="first_half", team_id=first.home_team_id,
            player_id=former_player.id, assist_player_id=self.players[1].id,
            outcome="goal", payload={}, voided=False, created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        statements = []

        def count_queries(connection, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(db.engine, "before_cursor_execute", count_queries)
        try:
            response = self.client.get(f"/api/cup/{tournament_id}")
            self.assertEqual(response.status_code, 200, response.json)
            self.assertLessEqual(len(statements), 12, statements)
            detail = response.json["tournament"]
            self.assertEqual(len(detail["matches"]), 10)
            self.assertEqual(detail["matches"][0]["home_goals"], 1)
            self.assertEqual(detail["matches"][0]["events"][0]["player"]["id"], former_player.id)
            self.assertEqual(detail["matches"][0]["participations"][0]["player"]["id"], former_player.id)
            self.assertEqual(detail["leaderboards"]["goals"][0]["total"], 1)
            self.assertEqual(detail["leaderboards"]["assists"][0]["player"]["id"], self.players[1].id)
            self.assertEqual(detail["leaderboards"]["appearances"][0]["total"], 1)
            self.assertTrue(all(not match["events"] for match in detail["matches"][1:]))
            statements.clear()
            summary = self.client.get("/api/cup?summary=1")
            self.assertEqual(summary.status_code, 200, summary.json)
            self.assertEqual(len(statements), 1)
            self.assertEqual(summary.json["tournaments"][0]["id"], tournament_id)
            self.assertNotIn("teams", summary.json["tournaments"][0])
            self.assertNotIn("matches", summary.json["tournaments"][0])
        finally:
            event.remove(db.engine, "before_cursor_execute", count_queries)
        duplicate = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "duplicate-batched-fixtures", "expected_version": generated.json["version"],
            "kickoff": "2026-11-14T10:00:00+00:00",
        })
        self.assertEqual(duplicate.status_code, 409)
        self.assertIn("Fixtures already exist", duplicate.json["error"])
        self.assertEqual(len(self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["matches"]), 10)
        self.assertEqual(db.session.get(Auction, 1).state, self.auction_state)

    def test_fixture_generation_publish_and_undo_can_be_reapplied(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-regenerate",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-regenerate", "expected_version": 0,
        })
        first = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-regenerate-1", "expected_version": imported.json["version"],
            "kickoff": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
        })
        self.assertEqual(first.status_code, 200, first.json)
        first_ids = db.session.scalars(select(CupMatch.id).where(
            CupMatch.tournament_id == tournament_id,
            CupMatch.state != "archived",
        )).all()
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id="
            f"{self.client.get(f'/api/cup/host/{tournament_id}/history').json['history'][-1]['id']}"
        ).json
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-fixtures-regenerate-1",
            "target_audit_id": preview["target"]["id"],
            "expected_version": preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        regenerated = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-regenerate-2", "expected_version": undone.json["version"],
            "kickoff": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
        })
        self.assertEqual(regenerated.status_code, 200, regenerated.json)
        regenerated_ids = db.session.scalars(select(CupMatch.id).where(
            CupMatch.tournament_id == tournament_id,
            CupMatch.state != "archived",
        )).all()
        self.assertTrue(set(first_ids).isdisjoint(regenerated_ids))
        active_orders = db.session.scalars(select(CupMatch.match_order).where(
            CupMatch.tournament_id == tournament_id,
            CupMatch.state != "archived",
        )).all()
        self.assertEqual(sorted(active_orders), list(range(11, 21)))

        published = self.post(f"/api/cup/host/{tournament_id}/publish", csrf, {
            "request_id": "publish-regenerated", "expected_version": regenerated.json["version"],
        })
        self.assertEqual(published.status_code, 200, published.json)
        publish_audit = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        publish_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={publish_audit}"
        ).json
        undo_publish = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-publish-regenerated", "target_audit_id": publish_audit,
            "expected_version": publish_preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undo_publish.status_code, 200, undo_publish.json)
        republished = self.post(f"/api/cup/host/{tournament_id}/publish", csrf, {
            "request_id": "republish-regenerated", "expected_version": undo_publish.json["version"],
        })
        self.assertEqual(republished.status_code, 200, republished.json)

    def test_publishing_allows_consecutive_fixtures_with_host_controlled_kickoff(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-consecutive-publish",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-consecutive-publish", "expected_version": 0,
        })
        generated = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-consecutive-publish", "expected_version": imported.json["version"],
            "kickoff": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        })
        self.assertEqual(generated.status_code, 200, generated.json)
        matches = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id,
            CupMatch.state == "draft",
        ).order_by(CupMatch.match_order)).all()
        self.assertEqual(len(matches), 10)
        shared_team = matches[0].home_team_id
        self.assertNotEqual(shared_team, matches[1].away_team_id)
        matches[1].home_team_id = shared_team
        db.session.commit()

        published = self.post(f"/api/cup/host/{tournament_id}/publish", csrf, {
            "request_id": "publish-consecutive-fixtures",
            "expected_version": generated.json["version"],
        })
        self.assertEqual(published.status_code, 200, published.json)
        self.assertEqual([row.state for row in matches[:2]], ["scheduled", "scheduled"])
        self.assertEqual(matches[0].home_team_id, matches[1].home_team_id)

    def test_lineup_replacement_keeps_validation_and_can_be_undone(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "create-lineup-edit"})
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-lineup-edit", "expected_version": 0,
        })
        settings = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": "settings-lineup-edit", "expected_version": imported.json["version"],
            "settings": {"players_per_side": 1},
        })
        generated = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-lineup-edit", "expected_version": settings.json["version"],
            "kickoff": datetime.now(timezone.utc).isoformat(),
        })
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        match = detail["matches"][0]
        sides = [next(team for team in detail["teams"] if team["id"] == team_id)
                 for team_id in (match["home_team_id"], match["away_team_id"])]
        rows = [
            {"player_id": player["id"], "team_id": team["id"],
             "status": "starter" if index == 0 else "bench", "goalkeeper": index == 0}
            for team in sides for index, player in enumerate(team["players"])
        ]
        def save(request_id, version, match_version, players):
            return self.post(f"/api/cup/host/matches/{match['id']}/lineup", csrf, {
                "request_id": request_id, "expected_version": version,
                "expected_match_version": match_version, "players": players,
            })
        first = save("lineup-first-save", generated.json["version"], 0, rows)
        self.assertEqual(first.status_code, 200, first.json)
        edited = [dict(row) for row in rows]
        edited[0].update(status="bench", goalkeeper=False)
        edited[1].update(status="starter", goalkeeper=True)
        wrong_team = [dict(row) for row in edited]
        wrong_team[0]["team_id"] = sides[1]["id"]
        rejected = save("lineup-wrong-team", first.json["version"], 1, wrong_team)
        self.assertEqual(rejected.status_code, 400, rejected.json)
        self.assertIn("active cup roster", rejected.json["error"])
        stale = save("lineup-stale-save", first.json["version"], 0, edited)
        self.assertEqual(stale.status_code, 409, stale.json)
        second = save("lineup-second-save", first.json["version"], 1, edited)
        self.assertEqual(second.status_code, 200, second.json)
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-lineup-edit", "target_audit_id": history[-1]["id"],
            "expected_version": second.json["version"], "cascade": False,
        })
        self.assertEqual(undo.status_code, 200, undo.json)
        restored = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["matches"][0]["participations"]
        self.assertEqual(
            {(row["player"]["id"], row["team_id"], row["status"], row["goalkeeper"]) for row in restored},
            {(row["player_id"], row["team_id"], row["status"], row["goalkeeper"]) for row in rows},
        )

    def test_out_of_order_early_kickoff_preserves_pitch_and_lineup_guards_without_rest_blocking(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-kickoff-guards",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-kickoff-guards", "expected_version": 0,
        })
        settings = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": "settings-kickoff-guards", "expected_version": imported.json["version"],
            "settings": {
                "players_per_side": 1, "half_minutes": 1, "break_minutes": 0,
                "between_match_rest_minutes": 15, "playoff_rest_minutes": 60,
            },
        })
        generated = self.post(f"/api/cup/host/{tournament_id}/fixtures", csrf, {
            "request_id": "fixtures-kickoff-guards", "expected_version": settings.json["version"],
            "kickoff": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
        })
        published = self.post(f"/api/cup/host/{tournament_id}/publish", csrf, {
            "request_id": "publish-kickoff-guards", "expected_version": generated.json["version"],
        })
        self.assertEqual(published.status_code, 200, published.json)
        matches = db.session.scalars(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id,
            CupMatch.state != "archived",
        ).order_by(CupMatch.match_order)).all()
        premature = self.post(f"/api/cup/host/matches/{matches[0].id}/clock", csrf, {
            "request_id": "kickoff-before-start", "expected_version": published.json["version"],
            "expected_match_version": matches[0].version, "command": "kickoff",
        })
        self.assertEqual(premature.status_code, 409)

        started = self.post(f"/api/cup/host/{tournament_id}/start", csrf, {
            "request_id": "start-kickoff-guards", "expected_version": published.json["version"],
        })
        self.assertEqual(started.status_code, 200, started.json)
        tournament_version = started.json["version"]
        missing_lineup = self.post(f"/api/cup/host/matches/{matches[0].id}/clock", csrf, {
            "request_id": "kickoff-without-lineup", "expected_version": tournament_version,
            "expected_match_version": matches[0].version, "command": "kickoff",
        })
        self.assertEqual(missing_lineup.status_code, 409, missing_lineup.json)
        self.assertIn("starting players", missing_lineup.json["error"])
        memberships = db.session.scalars(select(CupRosterMembership).where(
            CupRosterMembership.tournament_id == tournament_id,
            CupRosterMembership.active.is_(True),
        )).all()
        player_by_team = {}
        for membership in memberships:
            player_by_team.setdefault(membership.team_id, membership.player_id)
        later = matches[-1]
        earlier = next(row for row in matches[:-1] if {
            row.home_team_id, row.away_team_id
        } & {later.home_team_id, later.away_team_id})
        later.scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
        db.session.commit()
        for index, match in enumerate((earlier, later)):
            response = self.post(f"/api/cup/host/matches/{match.id}/lineup", csrf, {
                "request_id": f"lineup-kickoff-{index}",
                "expected_version": tournament_version,
                "expected_match_version": match.version,
                "players": [
                    {"player_id": player_by_team[team_id], "team_id": team_id,
                     "status": "starter", "goalkeeper": True}
                    for team_id in (match.home_team_id, match.away_team_id)
                ],
            })
            self.assertEqual(response.status_code, 200, response.json)
            tournament_version = response.json["version"]

        first_start = self.post(f"/api/cup/host/matches/{later.id}/clock", csrf, {
            "request_id": "kickoff-later-early", "expected_version": tournament_version,
            "expected_match_version": later.version, "command": "kickoff",
        })
        self.assertEqual(first_start.status_code, 200, first_start.json)
        tournament_version = first_start.json["version"]
        occupied = self.post(f"/api/cup/host/matches/{earlier.id}/clock", csrf, {
            "request_id": "kickoff-earlier-occupied", "expected_version": tournament_version,
            "expected_match_version": earlier.version, "command": "kickoff",
        })
        self.assertEqual(occupied.status_code, 409)
        self.assertIn("pitch", occupied.json["error"])

        finished_at = datetime.now(timezone.utc)
        later.state = "finalized"
        later.finalized_at = finished_at
        db.session.commit()
        allowed = self.post(f"/api/cup/host/matches/{earlier.id}/clock", csrf, {
            "request_id": "kickoff-earlier-immediately", "expected_version": tournament_version,
            "expected_match_version": earlier.version, "command": "kickoff",
        })
        self.assertEqual(allowed.status_code, 200, allowed.json)

    def test_exact_tie_resolution_is_audited_and_undoable(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-tied-cup",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-tied-cup", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        when = datetime.now(timezone.utc) - timedelta(hours=1)
        db.session.add_all([
            CupMatch(
                tournament_id=tournament_id, stage="league",
                home_team_id=home_id, away_team_id=away_id,
                match_order=order, scheduled_at=when, state="finalized",
                settings={}, version=0, clock={}, finalized_at=when,
            )
            for order, (home_id, away_id) in enumerate(
                build_league_fixtures([team.id for team in self.teams]), start=1,
            )
        ])
        db.session.commit()
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(detail["unresolved_tie"], "Host ranking decision required")

        rejected = self.post(f"/api/cup/host/{tournament_id}/tie-resolution", csrf, {
            "request_id": "bad-tie-order", "expected_version": 1,
            "team_orders": [[self.teams[0].id]],
        })
        self.assertEqual(rejected.status_code, 400, rejected.json)
        team_order = [team.id for team in reversed(self.teams)]
        duplicate_order = [team_order[0], team_order[0], *team_order[1:]]
        duplicate = self.post(f"/api/cup/host/{tournament_id}/tie-resolution", csrf, {
            "request_id": "duplicate-tie-order", "expected_version": 1,
            "team_orders": [duplicate_order],
        })
        self.assertEqual(duplicate.status_code, 400, duplicate.json)
        resolved = self.post(f"/api/cup/host/{tournament_id}/tie-resolution", csrf, {
            "request_id": "resolve-tie", "expected_version": 1,
            "team_orders": [team_order],
        })
        self.assertEqual(resolved.status_code, 200, resolved.json)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertIsNone(detail["unresolved_tie"])
        self.assertEqual([row["id"] for row in detail["standings"]], team_order)
        self.assertEqual([row["rank"] for row in detail["standings"]], [1, 2, 3, 4, 5])

        qualified = self.post(f"/api/cup/host/{tournament_id}/playoffs", csrf, {
            "request_id": "qualify-resolved-tie", "expected_version": 2,
            "kickoff": datetime.now(timezone.utc).isoformat(),
        })
        self.assertEqual(qualified.status_code, 200, qualified.json)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(
            [(row["stage"], row["home_team_id"], row["away_team_id"])
             for row in detail["matches"][-2:]],
            [
                ("third_place", team_order[2], team_order[3]),
                ("final", team_order[0], team_order[1]),
            ],
        )
        playoff_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        playoff_preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={playoff_audit_id}"
        ).json
        undone_playoffs = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-resolved-playoffs",
            "target_audit_id": playoff_audit_id,
            "expected_version": playoff_preview["expected_version"],
            "cascade": False,
        })
        self.assertEqual(undone_playoffs.status_code, 200, undone_playoffs.json)

        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        audit_id = next(
            row["id"] for row in history if row["action"] == "tie_resolution"
        )
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={audit_id}"
        ).json
        self.assertEqual(preview["affected"], [])
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-tie", "target_audit_id": audit_id,
            "expected_version": preview["expected_version"], "cascade": False,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        self.assertEqual(
            self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["unresolved_tie"],
            "Host ranking decision required",
        )

    def test_undoing_pause_excludes_wall_time_after_the_clock_command(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-clock-undo",
        })
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-clock-undo", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        started_at = datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc)
        tournament = db.session.get(CupTournament, tournament_id)
        tournament.lifecycle = "running"
        match = CupMatch(
            tournament_id=tournament_id, stage="league",
            home_team_id=self.teams[0].id, away_team_id=self.teams[1].id,
            match_order=1, scheduled_at=started_at - timedelta(minutes=10),
            state="live", settings={}, version=0,
            clock={
                "period": "first_half", "elapsed_seconds": 12,
                "anchor": started_at.isoformat(), "paused": False,
            },
        )
        db.session.add(match)
        db.session.commit()
        clock_time = [started_at + timedelta(seconds=30)]
        with patch("cup._now", side_effect=lambda: clock_time[0]):
            paused = self.post(f"/api/cup/host/matches/{match.id}/clock", csrf, {
                "request_id": "pause-clock-undo", "expected_version": 1,
                "expected_match_version": 0, "command": "pause",
            })
        self.assertEqual(paused.status_code, 200, paused.json)
        pause_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        clock_time[0] += timedelta(seconds=100)
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={pause_audit_id}"
        ).json
        with patch("cup._now", side_effect=lambda: clock_time[0]):
            undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
                "request_id": "undo-pause-clock", "target_audit_id": pause_audit_id,
                "expected_version": preview["expected_version"], "cascade": False,
            })
        self.assertEqual(undone.status_code, 200, undone.json)
        db.session.refresh(match)
        self.assertEqual(match.state, "live")
        self.assertEqual(match.clock["elapsed_seconds"], 42)
        self.assertEqual(match.clock["anchor"], clock_time[0].isoformat())

    def test_upcoming_playoff_rescheduling_enforces_rest_and_is_undoable(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "create-reschedule"})
        tournament_id = created.json["tournament_id"]
        tournament = db.session.get(CupTournament, tournament_id)
        tournament.lifecycle = "running"
        finished = datetime.now(timezone.utc) - timedelta(hours=4)
        third_time = finished + timedelta(hours=2)
        final_time = third_time + timedelta(hours=2)
        matches = [
            CupMatch(tournament_id=tournament_id, stage="league", home_team_id=1, away_team_id=2,
                     match_order=10, scheduled_at=finished - timedelta(hours=1),
                     finalized_at=finished, state="finalized", settings={}, version=0, clock={}),
            CupMatch(tournament_id=tournament_id, stage="third_place", home_team_id=3, away_team_id=4,
                     match_order=11, scheduled_at=third_time, state="scheduled", settings={}, version=0, clock={}),
            CupMatch(tournament_id=tournament_id, stage="final", home_team_id=1, away_team_id=2,
                     match_order=12, scheduled_at=final_time, state="scheduled", settings={}, version=0, clock={}),
        ]
        db.session.add_all(matches)
        db.session.commit()
        third, final = matches[1:]
        def reschedule(match, kickoff, request_id, version=0):
            return self.post(f"/api/cup/host/matches/{match.id}/reschedule", csrf, {
                "request_id": request_id, "expected_version": version, "kickoff": kickoff.isoformat(),
            })
        self.assertEqual(reschedule(third, finished, "too-soon-reschedule").status_code, 400)
        self.assertEqual(reschedule(third, final_time, "overlap-reschedule").status_code, 400)
        new_time = third_time + timedelta(minutes=10)
        response = reschedule(third, new_time, "valid-reschedule")
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(db.session.get(CupMatch, third.id).scheduled_at.replace(tzinfo=timezone.utc), new_time)
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        target = next(row["id"] for row in history if row["action"] == "playoff_reschedule")
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-reschedule", "expected_version": 1, "target_audit_id": target,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        self.assertEqual(db.session.get(CupMatch, third.id).scheduled_at.replace(tzinfo=timezone.utc), third_time)
        third.state = "finalized"
        third.finalized_at = final_time + timedelta(hours=1)
        db.session.commit()
        self.assertEqual(reschedule(final, final_time, "delayed-rest-reschedule", 2).status_code, 400)
        self.assertEqual(reschedule(third, new_time, "started-reschedule", 2).status_code, 409)

    def test_profile_undo_is_blocked_if_another_tournament_uses_it(self):
        csrf = self.login()
        first = self.post("/api/cup/host/tournaments", csrf, {"request_id": "first-cup"})
        first_id = first.json["tournament_id"]
        added = self.post(f"/api/cup/host/{first_id}/profiles", csrf, {
            "request_id": "new-player", "expected_version": 0, "entity": "player",
            "id": None, "name": "New Cup Player", "position": "MID", "photo_path": "",
        })
        self.assertEqual(added.status_code, 200, added.json)
        history = self.client.get(f"/api/cup/host/{first_id}/history").json["history"]
        player_action = next(row for row in history if row["action"] == "cup_profile")
        player_id = player_action["details"]["profile_id"]
        second = self.post("/api/cup/host/tournaments", csrf, {"request_id": "second-cup"})
        second_id = second.json["tournament_id"]
        db.session.add(CupRosterMembership(
            tournament_id=second_id, team_id=self.teams[0].id, player_id=player_id,
            active=True, created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        preview = self.client.get(
            f"/api/cup/host/{first_id}/undo-preview?target_audit_id={player_action['id']}"
        )
        self.assertEqual(preview.status_code, 409, preview.json)
        undone = self.post(f"/api/cup/host/{first_id}/undo", csrf, {
            "request_id": "unsafe-undo", "expected_version": 1,
            "target_audit_id": player_action["id"],
        })
        self.assertEqual(undone.status_code, 409, undone.json)
        self.assertTrue(db.session.get(CupPlayer, player_id).active)
        self.assertEqual(db.session.get(CupTournament, first_id).version, 1)

    def test_cup_image_upload_is_independent_and_profile_edit_undoable(self):
        image_bytes = BytesIO()
        Image.new("RGB", (4, 4), "blue").save(image_bytes, format="PNG")
        image_contents = image_bytes.getvalue()
        anonymous = self.client.post("/api/cup/uploads", data={"file": (BytesIO(image_contents), "photo.png")})
        self.assertEqual(anonymous.status_code, 401)
        csrf = self.login()
        with TemporaryDirectory() as directory:
            cup_folder = Path(directory) / "cup"
            original_folder = Path(directory) / "auction"
            original_folder.mkdir()
            original = original_folder / "original.jpg"
            original.write_bytes(b"untouched")
            self.app.config.update(CUP_UPLOAD_FOLDER=str(cup_folder), UPLOAD_FOLDER=str(original_folder))
            invalid = self.client.post("/api/cup/uploads", headers={"X-CSRF-Token": csrf},
                                       data={"file": (BytesIO(b"not an image"), "invalid.png")})
            self.assertEqual(invalid.status_code, 400)
            uploaded = self.client.post(
                "/api/cup/uploads", headers={"X-CSRF-Token": csrf},
                data={"file": (BytesIO(image_contents), "photo.png")},
            )
            self.assertEqual(uploaded.status_code, 201, uploaded.json)
            image_path = uploaded.json["path"]
            self.assertEqual(self.client.get(image_path).status_code, 200)
            self.assertEqual(original.read_bytes(), b"untouched")
            created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "upload-cup-create"})
            tournament_id = created.json["tournament_id"]
            changed = self.post(f"/api/cup/host/{tournament_id}/profiles", csrf, {
                "request_id": "upload-profile-change", "expected_version": 0,
                "entity": "player", "id": self.players[0].id,
                "name": self.players[0].name, "position": "GK", "photo_path": image_path,
            })
            self.assertEqual(changed.status_code, 200, changed.json)
            history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
            action = next(row for row in history if row["action"] == "cup_profile")
            undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
                "request_id": "upload-profile-undo", "expected_version": 1,
                "target_audit_id": action["id"],
            })
            self.assertEqual(undo.status_code, 200, undo.json)
            self.assertEqual(db.session.get(CupPlayer, self.players[0].id).photo_path, self.players[0].photo_path)
            self.assertEqual(original.read_bytes(), b"untouched")
            self.app.config["CUP_UPLOAD_FOLDER"] = str(original_folder / "overlap")
            denied = self.client.post("/api/cup/uploads", headers={"X-CSRF-Token": csrf},
                                      data={"file": (BytesIO(image_contents), "photo.png")})
            self.assertEqual(denied.status_code, 503)

    def test_finalized_shot_correction_uses_historical_lineup_and_is_undoable(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "correction-create"})
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "correction-import", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        db.session.add(CupPlayer(id=11, name="Sub", position="DEF", photo_path="", active=True))
        match = CupMatch(
            tournament_id=tournament_id, stage="league", home_team_id=1, away_team_id=2,
            match_order=1, state="live", settings={}, version=0,
            clock={"period": "first_half", "paused": False, "elapsed_seconds": 0},
        )
        db.session.add(match)
        db.session.flush()
        match_id = match.id
        db.session.add_all([
            CupParticipation(match_id=match_id, team_id=1, player_id=1, status="starter", goalkeeper=True),
            CupParticipation(match_id=match_id, team_id=1, player_id=2, status="starter", goalkeeper=False),
            CupParticipation(match_id=match_id, team_id=1, player_id=11, status="bench", goalkeeper=False),
            CupParticipation(match_id=match_id, team_id=2, player_id=3, status="starter", goalkeeper=True),
            CupParticipation(match_id=match_id, team_id=2, player_id=4, status="starter", goalkeeper=False),
        ])
        db.session.commit()
        goal = self.post(f"/api/cup/host/matches/{match_id}/events", csrf, {
            "request_id": "correction-goal", "expected_version": 1, "expected_match_version": 0,
            "event_type": "shot", "outcome": "goal", "period": "first_half", "minute": 1,
            "team_id": 1, "player_id": 2, "assist_player_id": 1,
        })
        self.assertEqual(goal.status_code, 200, goal.json)
        event_id = goal.json["event_id"]
        sub = self.post(f"/api/cup/host/matches/{match_id}/events", csrf, {
            "request_id": "correction-sub", "expected_version": 2, "expected_match_version": 1,
            "event_type": "substitution", "period": "first_half", "minute": 2,
            "team_id": 1, "player_id": 2, "incoming_player_id": 11,
        })
        self.assertEqual(sub.status_code, 200, sub.json)
        match = db.session.get(CupMatch, match_id)
        match.state = "finalized"
        match.finalized_at = datetime.now(timezone.utc)
        db.session.commit()
        path = f"/api/cup/host/matches/{match_id}/events/{event_id}/correct"
        body = {"request_id": "correction-save", "expected_version": 3, "expected_match_version": 2,
                "team_id": 1, "player_id": 2, "outcome": "saved", "goalkeeper_id": 3}
        self.assertEqual(self.post(path, csrf, body).status_code, 400)
        body["confirm_finalized"] = True
        crossed = self.post(path, csrf, {**body, "request_id": "crossed-substitution", "minute": 3})
        self.assertEqual(crossed.status_code, 409, crossed.json)
        changed = self.post(path, csrf, body)
        self.assertEqual(changed.status_code, 200, changed.json)
        details = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(details["matches"][0]["home_goals"], 0)
        self.assertEqual(details["leaderboards"]["saves"][0]["total"], 1)
        action = next(row for row in self.client.get(
            f"/api/cup/host/{tournament_id}/history").json["history"] if row["action"] == "event_correction")
        undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "correction-undo", "expected_version": 4, "target_audit_id": action["id"],
        })
        self.assertEqual(undo.status_code, 200, undo.json)
        restored = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(restored["matches"][0]["home_goals"], 1)
        self.assertEqual(restored["leaderboards"]["assists"][0]["total"], 1)
        self.assertEqual(db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match_id, CupParticipation.player_id == 2)).status, "substituted")
        db.session.add(CupMatch(tournament_id=tournament_id, stage="final", home_team_id=1, away_team_id=2,
                                match_order=2, state="scheduled", settings={}, version=0, clock={}))
        db.session.commit()
        denied = self.post(path, csrf, {**body, "request_id": "dependent-correction",
                                        "expected_version": 5, "expected_match_version": 4})
        self.assertEqual(denied.status_code, 409, denied.json)
        self.assertEqual(db.session.get(CupMatchEvent, event_id).outcome, "goal")

    def test_finalized_omitted_events_and_structural_corrections_are_reversible(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "omitted-create"})
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "omitted-import", "expected_version": 0,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        db.session.add_all([
            CupPlayer(id=index, name=f"Sub {index}", position="DEF", photo_path="", active=True)
            for index in (11, 12)
        ])
        match = CupMatch(tournament_id=tournament_id, stage="league", home_team_id=1, away_team_id=2,
                         match_order=1, state="live", settings={}, version=0,
                         clock={"period": "second_half", "paused": False, "elapsed_seconds": 0,
                                "played_seconds": 60})
        db.session.add(match)
        db.session.flush()
        match_id = match.id
        db.session.add_all([
            CupParticipation(match_id=match_id, team_id=1, player_id=1, status="starter", goalkeeper=True),
            CupParticipation(match_id=match_id, team_id=1, player_id=2, status="starter", goalkeeper=False),
            CupParticipation(match_id=match_id, team_id=1, player_id=11, status="bench", goalkeeper=False),
            CupParticipation(match_id=match_id, team_id=1, player_id=12, status="bench", goalkeeper=False),
            CupParticipation(match_id=match_id, team_id=2, player_id=3, status="starter", goalkeeper=True),
        ])
        db.session.add(CupAudit(
            tournament_id=tournament_id, match_id=match_id, request_id="played-second-half",
            action="match_clock", actor_hash=None, expected_version=1,
            details={"after": {"clock": {"period": "second_half"}}}, inverse={},
            created_at=datetime.now(timezone.utc),
        ))
        db.session.commit()
        card = self.post(f"/api/cup/host/matches/{match_id}/events", csrf, {
            "request_id": "original-yellow", "expected_version": 1, "expected_match_version": 0,
            "event_type": "yellow_card", "period": "second_half", "minute": 2, "team_id": 1, "player_id": 2,
        })
        self.assertEqual(card.status_code, 200, card.json)
        match.state = "finalized"
        match.finalized_at = datetime.now(timezone.utc)
        db.session.commit()
        card_id = card.json["event_id"]
        changed = self.post(f"/api/cup/host/matches/{match_id}/events/{card_id}/correct", csrf, {
            "request_id": "yellow-to-red", "expected_version": 2, "expected_match_version": 1,
            "event_type": "red_card", "team_id": 1, "player_id": 2, "confirm_finalized": True,
        })
        self.assertEqual(changed.status_code, 200, changed.json)
        participant = db.session.scalar(select(CupParticipation).where(
            CupParticipation.match_id == match_id, CupParticipation.player_id == 2))
        self.assertEqual(participant.status, "dismissed")
        stats = self.client.get("/api/cup/players/2").json["player"]["statistics"]
        self.assertEqual((stats["yellow_cards"], stats["red_cards"]), (0, 1))
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        correction = next(row for row in history if row["action"] == "event_correction")
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-card-correction", "expected_version": 3, "target_audit_id": correction["id"],
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        self.assertEqual(participant.status, "starter")
        goal = self.post(f"/api/cup/host/matches/{match_id}/events", csrf, {
            "request_id": "omitted-goal", "expected_version": 4, "expected_match_version": 3,
            "historical": True, "confirm_finalized": True, "event_type": "shot", "outcome": "goal",
            "period": "second_half", "minute": 3, "team_id": 1, "player_id": 2, "assist_player_id": 1,
        })
        self.assertEqual(goal.status_code, 200, goal.json)
        self.assertEqual(self.client.get(f"/api/cup/matches/{match_id}").json["match"]["home_goals"], 1)
        unsafe_card = self.post(f"/api/cup/host/matches/{match_id}/events/{card_id}/correct", csrf, {
            "request_id": "card-has-dependent-goal", "expected_version": 5, "expected_match_version": 4,
            "event_type": "red_card", "team_id": 1, "player_id": 2, "confirm_finalized": True,
        })
        self.assertEqual(unsafe_card.status_code, 409, unsafe_card.json)
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        goal_action = next(row for row in history if row["details"].get("event_id") == goal.json["event_id"])
        undone_goal = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-omitted-goal", "expected_version": 5, "target_audit_id": goal_action["id"],
        })
        self.assertEqual(undone_goal.status_code, 200, undone_goal.json)
        sub = self.post(f"/api/cup/host/matches/{match_id}/events", csrf, {
            "request_id": "omitted-sub", "expected_version": 6, "expected_match_version": 5,
            "historical": True, "confirm_finalized": True, "event_type": "substitution",
            "period": "second_half", "minute": 3, "team_id": 1, "player_id": 2, "incoming_player_id": 11,
        })
        self.assertEqual(sub.status_code, 200, sub.json)
        fixed_sub = self.post(f"/api/cup/host/matches/{match_id}/events/{sub.json['event_id']}/correct", csrf, {
            "request_id": "fix-omitted-sub", "expected_version": 7, "expected_match_version": 6,
            "confirm_finalized": True, "team_id": 1, "player_id": 2,
            "event_type": "substitution", "incoming_player_id": 12,
        })
        self.assertEqual(fixed_sub.status_code, 200, fixed_sub.json)
        statuses = {row.player_id: row.status for row in db.session.scalars(
            select(CupParticipation).where(CupParticipation.match_id == match_id)).all()}
        self.assertEqual((statuses[2], statuses[11], statuses[12]), ("substituted", "bench", "entered"))
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        correction = [row for row in history if row["action"] == "event_correction"][-1]
        undone_sub = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-sub-correction", "expected_version": 8, "target_audit_id": correction["id"],
        })
        self.assertEqual(undone_sub.status_code, 200, undone_sub.json)
        statuses = {row.player_id: row.status for row in db.session.scalars(
            select(CupParticipation).where(CupParticipation.match_id == match_id)).all()}
        self.assertEqual((statuses[2], statuses[11], statuses[12]), ("substituted", "entered", "bench"))
        unsafe = self.post(f"/api/cup/host/matches/{match_id}/events", csrf, {
            "request_id": "too-early-omission", "expected_version": 9, "expected_match_version": 8,
            "historical": True, "confirm_finalized": True, "event_type": "shot", "outcome": "goal",
            "period": "second_half", "minute": 1, "team_id": 1, "player_id": 11,
        })
        self.assertEqual(unsafe.status_code, 409, unsafe.json)

    def _league_match_fixture(self, csrf, prefix, state, clock, rows):
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": f"create-{prefix}"})
        tournament_id = created.json["tournament_id"]
        settings = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": f"settings-{prefix}", "expected_version": 0,
            "settings": {"players_per_side": 2, "half_minutes": 7, "break_minutes": 2},
        })
        self.assertEqual(settings.status_code, 200, settings.json)
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": f"import-{prefix}", "expected_version": 1,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        db.session.get(CupTournament, tournament_id).lifecycle = "running"
        match = CupMatch(
            tournament_id=tournament_id, stage="league",
            home_team_id=self.teams[0].id, away_team_id=self.teams[1].id,
            match_order=1, scheduled_at=datetime.now(timezone.utc) - timedelta(hours=1),
            state=state, settings={}, version=0, clock=clock,
        )
        db.session.add(match)
        db.session.flush()
        db.session.add_all([
            CupParticipation(match_id=match.id, team_id=team_id, player_id=player_id,
                             status=status, goalkeeper=goalkeeper)
            for team_id, player_id, status, goalkeeper in rows
        ])
        db.session.commit()
        return tournament_id, match

    def test_live_event_minutes_come_from_played_server_time(self):
        csrf = self.login()
        t0 = datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc)
        home, away = self.teams[0].id, self.teams[1].id
        tournament_id, match = self._league_match_fixture(csrf, "minutes", "live", {
            "period": "first_half", "elapsed_seconds": 0, "anchor": t0.isoformat(),
            "paused": False, "played_seconds": 0,
        }, [(home, 1, "starter", True), (home, 2, "starter", False),
            (away, 3, "starter", True), (away, 4, "starter", False)])
        versions = {"tv": 2, "mv": 0}

        def call(path, seconds, body, request_id):
            with patch("cup._now", return_value=t0 + timedelta(seconds=seconds)):
                response = self.post(path, csrf, {
                    "request_id": request_id, "expected_version": versions["tv"],
                    "expected_match_version": versions["mv"], **body,
                })
            if response.status_code == 200:
                versions["tv"] += 1
                versions["mv"] += 1
            return response

        events = f"/api/cup/host/matches/{match.id}/events"
        clock = f"/api/cup/host/matches/{match.id}/clock"
        goal = call(events, 90, {"event_type": "shot", "outcome": "goal", "minute": 99,
                                 "team_id": home, "player_id": 2}, "timed-goal")
        self.assertEqual(goal.status_code, 200, goal.json)
        self.assertEqual(goal.json["minute"], 2)
        self.assertEqual(call(clock, 130, {"command": "pause"}, "timed-pause").status_code, 200)
        paused_shot = call(events, 400, {"event_type": "shot", "outcome": "off_target",
                                         "team_id": away, "player_id": 4}, "paused-shot")
        self.assertEqual(paused_shot.json["minute"], 3, paused_shot.json)
        self.assertEqual(call(clock, 500, {"command": "resume"}, "timed-resume").status_code, 200)
        ended = call(clock, 800, {"command": "end_period"}, "timed-half")
        self.assertEqual(ended.json["clock"]["played_seconds"], 430, ended.json)
        during_break = call(events, 830, {"event_type": "shot", "outcome": "off_target",
                                          "team_id": away, "player_id": 4}, "break-shot")
        self.assertEqual(during_break.status_code, 409, during_break.json)
        self.assertEqual(call(clock, 900, {"command": "resume"}, "timed-second").status_code, 200)
        second = call(events, 945, {"event_type": "shot", "outcome": "off_target",
                                    "team_id": away, "player_id": 4}, "second-shot")
        self.assertEqual((second.json["minute"], db.session.get(CupMatchEvent, second.json["event_id"]).period),
                         (8, "second_half"))
        omitted = call(events, 950, {"historical": True, "event_type": "shot", "outcome": "off_target",
                                     "period": "second_half", "minute": 8,
                                     "team_id": home, "player_id": 2}, "manual-omitted")
        self.assertEqual(omitted.json.get("minute"), 8, omitted.json)

    def test_bench_fill_adds_only_missing_eligible_players_and_is_undoable(self):
        csrf = self.login()
        home, away = self.teams[0].id, self.teams[1].id
        tournament_id, match = self._league_match_fixture(csrf, "bench", "live", {
            "period": "first_half", "elapsed_seconds": 0, "anchor": datetime.now(timezone.utc).isoformat(),
            "paused": False, "played_seconds": 0,
        }, [(home, 1, "starter", True), (home, 2, "dismissed", False), (away, 3, "starter", True)])
        path = f"/api/cup/host/matches/{match.id}/bench"
        filled = self.post(path, csrf, {"request_id": "fill-bench", "expected_version": 2,
                                        "expected_match_version": 0})
        self.assertEqual(filled.status_code, 200, filled.json)
        self.assertEqual(filled.json["added"], [{"player_id": 4, "team_id": away}])
        rows = {row.player_id: row.status for row in db.session.scalars(
            select(CupParticipation).where(CupParticipation.match_id == match.id)).all()}
        self.assertEqual(rows, {1: "starter", 2: "dismissed", 3: "starter", 4: "bench"})
        repeat = self.post(path, csrf, {"request_id": "fill-bench-again", "expected_version": 3,
                                        "expected_match_version": 1})
        self.assertEqual(repeat.status_code, 409, repeat.json)
        audit_id = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"][-1]["id"]
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-fill-bench", "expected_version": 3, "target_audit_id": audit_id,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        self.assertEqual({row.player_id for row in db.session.scalars(
            select(CupParticipation).where(CupParticipation.match_id == match.id)).all()}, {1, 2, 3})
        match.state = "scheduled"
        db.session.commit()
        scheduled = self.post(path, csrf, {"request_id": "fill-scheduled", "expected_version": 4,
                                           "expected_match_version": match.version})
        self.assertEqual(scheduled.status_code, 409, scheduled.json)

    def test_finalized_league_draw_can_be_reopened_for_penalties_keeping_finish_time(self):
        csrf = self.login()
        home, away = self.teams[0].id, self.teams[1].id
        tournament_id, match = self._league_match_fixture(csrf, "reopen-pens", "finalized", {
            "period": "full_time", "elapsed_seconds": 0, "anchor": None, "paused": True,
        }, [(home, 1, "starter", True), (home, 2, "starter", False),
            (away, 3, "starter", True), (away, 4, "starter", False)])
        finished = datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc)
        match.finalized_at = finished
        other = CupMatch(tournament_id=tournament_id, stage="league", home_team_id=self.teams[1].id,
                         away_team_id=self.teams[2].id, match_order=2, state="live", settings={}, version=0,
                         clock={"period": "first_half", "elapsed_seconds": 0, "anchor": None, "paused": False})
        db.session.add(other)
        db.session.commit()
        clock = f"/api/cup/host/matches/{match.id}/clock"
        blocked = self.post(clock, csrf, {"request_id": "reopen-busy", "expected_version": 2,
                                          "expected_match_version": 0, "command": "league_shootout"})
        self.assertEqual(blocked.status_code, 409, blocked.json)
        other.state = "scheduled"
        db.session.commit()
        reopened = self.post(clock, csrf, {"request_id": "reopen-ok", "expected_version": 2,
                                           "expected_match_version": 0, "command": "league_shootout",
                                           "shootout_kicks": 1})
        self.assertEqual((reopened.status_code, reopened.json.get("match_state")), (200, "review"), reopened.json)
        table = {row["id"]: row for row in self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["standings"]}
        self.assertEqual(table[home]["played"], 0)
        for index, (team_id, player_id, scored) in enumerate(((home, 1, True), (away, 3, False))):
            attempt = self.post(f"/api/cup/host/matches/{match.id}/shootout", csrf, {
                "request_id": f"reopen-kick-{index}", "expected_version": 3 + index,
                "expected_match_version": 1 + index, "team_id": team_id, "player_id": player_id, "scored": scored,
            })
            self.assertEqual(attempt.status_code, 200, attempt.json)
        final = self.post(f"/api/cup/host/matches/{match.id}/finalize", csrf, {
            "request_id": "reopen-final", "expected_version": 5, "expected_match_version": 3,
        })
        self.assertEqual(final.status_code, 200, final.json)
        db.session.refresh(match)
        self.assertEqual(match.finalized_at.replace(tzinfo=timezone.utc), finished)
        table = {row["id"]: row for row in self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["standings"]}
        self.assertEqual((table[home]["points"], table[away]["points"], table[home]["goals_for"]), (3, 0, 0))
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        reopen_audit = next(row for row in history if row["details"].get("command") == "league_shootout")
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-reopen", "expected_version": 6, "target_audit_id": reopen_audit["id"], "cascade": True,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        db.session.refresh(match)
        self.assertEqual((match.state, match.clock["period"]), ("finalized", "full_time"))
        self.assertEqual(match.finalized_at.replace(tzinfo=timezone.utc), finished)
        table = {row["id"]: row for row in self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["standings"]}
        self.assertEqual((table[home]["points"], table[away]["points"]), (1, 1))
        db.session.add(CupMatch(tournament_id=tournament_id, stage="final", match_order=9, state="scheduled",
                                settings={}, version=0, clock={}))
        db.session.commit()
        late = self.post(clock, csrf, {"request_id": "reopen-late", "expected_version": 7,
                                       "expected_match_version": match.version, "command": "league_shootout"})
        self.assertEqual(late.status_code, 409, late.json)

    def test_drawn_league_match_can_optionally_be_settled_by_penalties(self):
        csrf = self.login()
        home, away = self.teams[0].id, self.teams[1].id
        tournament_id, match = self._league_match_fixture(csrf, "league-pens", "review", {
            "period": "full_time", "elapsed_seconds": 0, "anchor": None, "paused": True,
        }, [(home, 1, "starter", True), (home, 2, "starter", False),
            (away, 3, "starter", True), (away, 4, "starter", False)])
        db.session.add_all([
            CupMatchEvent(match_id=match.id, request_id=f"pens-goal-{team_id}", event_type="shot",
                          minute=3, period="first_half", team_id=team_id, player_id=player_id,
                          outcome="goal", payload={}, voided=False, created_at=datetime.now(timezone.utc))
            for team_id, player_id in ((home, 2), (away, 4))
        ])
        db.session.commit()
        versions = {"tv": 2, "mv": 0}

        def call(path, body, request_id):
            response = self.post(path, csrf, {
                "request_id": request_id, "expected_version": versions["tv"],
                "expected_match_version": versions["mv"], **body,
            })
            if response.status_code == 200:
                versions["tv"] += 1
                versions["mv"] += 1
            return response

        clock = f"/api/cup/host/matches/{match.id}/clock"
        shootout = f"/api/cup/host/matches/{match.id}/shootout"
        finalize = f"/api/cup/host/matches/{match.id}/finalize"
        not_selected = call(shootout, {"team_id": home, "player_id": 1, "scored": True}, "pens-not-selected")
        self.assertEqual(not_selected.status_code, 409, not_selected.json)
        opted = call(clock, {"command": "league_shootout", "shootout_kicks": 1}, "pens-opt-in")
        self.assertEqual(opted.json["clock"]["period"], "shootout", opted.json)
        for team_id, player_id, scored in ((home, 1, True), (away, 3, True)):
            self.assertEqual(call(shootout, {"team_id": team_id, "player_id": player_id,
                                             "scored": scored}, f"pens-attempt-{player_id}").status_code, 200)
        undecided = call(finalize, {}, "pens-finalize-early")
        self.assertEqual(undecided.status_code, 409, undecided.json)
        cancel_blocked = call(clock, {"command": "cancel_league_shootout"}, "pens-cancel-blocked")
        self.assertEqual(cancel_blocked.status_code, 409, cancel_blocked.json)
        for team_id, player_id, scored in ((home, 2, True), (away, 4, False)):
            self.assertEqual(call(shootout, {"team_id": team_id, "player_id": player_id,
                                             "scored": scored}, f"pens-sudden-{player_id}").status_code, 200)
        self.assertEqual(call(finalize, {}, "pens-finalize").status_code, 200)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        played = next(row for row in detail["matches"] if row["id"] == match.id)
        self.assertEqual((played["home_goals"], played["away_goals"], played["shootout"],
                          played["shootout_winner_team_id"]), (1, 1, {"home": 2, "away": 1}, home))
        table = {row["id"]: row for row in detail["standings"]}
        self.assertEqual([(table[team]["points"], table[team]["won"], table[team]["drawn"], table[team]["lost"],
                           table[team]["goals_for"], table[team]["goals_against"]) for team in (home, away)],
                         [(3, 1, 0, 0, 1, 1), (0, 0, 0, 1, 1, 1)])
        stats = self.client.get("/api/cup/players/2").json["player"]["statistics"]
        self.assertEqual(stats["goals"], 1)

        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        opt_in = next(row for row in history if row["details"].get("command") == "league_shootout")
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-pens", "expected_version": versions["tv"],
            "target_audit_id": opt_in["id"], "cascade": True,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        db.session.refresh(match)
        self.assertEqual((match.state, match.clock["period"], match.settings.get("league_shootout")),
                         ("review", "full_time", None))
        versions["tv"] += 1
        versions["mv"] = match.version
        self.assertEqual(call(clock, {"command": "league_shootout"}, "pens-again").status_code, 200)
        cancelled = call(clock, {"command": "cancel_league_shootout"}, "pens-cancel")
        self.assertEqual(cancelled.json["clock"]["period"], "full_time", cancelled.json)
        self.assertEqual(call(finalize, {}, "draw-finalize").status_code, 200)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        table = {row["id"]: row for row in detail["standings"]}
        self.assertEqual([(table[team]["points"], table[team]["drawn"]) for team in (home, away)],
                         [(1, 1), (1, 1)])
        self.assertIsNone(next(row for row in detail["matches"] if row["id"] == match.id)["shootout_winner_team_id"])

    def test_full_squad_penalties_reject_dismissed_inactive_and_opposing_players(self):
        csrf = self.login()
        home, away = self.teams[0].id, self.teams[1].id
        tournament_id, match = self._league_match_fixture(csrf, "squad-pens", "review", {
            "period": "shootout", "anchor": None,
        }, [(home, 1, "starter", True), (home, 2, "dismissed", False),
            (away, 3, "starter", True), (away, 4, "bench", False)])
        match.settings = {"league_shootout": True}
        for player_id, active in ((11, True), (12, True), (13, False)):
            db.session.add(CupPlayer(id=player_id, name=f"Squad {player_id}", position="DEF", photo_path="", active=active))
            db.session.add(CupRosterMembership(
                tournament_id=tournament_id, team_id=home, player_id=player_id,
                active=True, created_at=datetime.now(timezone.utc),
            ))
        db.session.commit()
        original = [(row.player_id, row.status, row.goalkeeper) for row in
                    db.session.scalars(select(CupParticipation).where(CupParticipation.match_id == match.id)).all()]

        def kick(player_id, team_id=home):
            return self.post(f"/api/cup/host/matches/{match.id}/shootout", csrf, {
                "request_id": f"squad-kick-{player_id}-{match.version}",
                "expected_version": db.session.get(CupTournament, tournament_id).version,
                "expected_match_version": match.version, "player_id": player_id,
                "team_id": team_id, "scored": True,
            })

        for player_id in (2, 3, 13):
            self.assertEqual(kick(player_id).status_code, 409)
        self.assertEqual(kick(11).status_code, 200)
        self.assertEqual(kick(4, away).status_code, 200)
        self.assertEqual(kick(11).status_code, 409)
        self.assertEqual(kick(12).status_code, 200)
        detail = self.client.get(f"/api/cup/matches/{match.id}").json["match"]
        self.assertEqual(detail["penalty_eligible_player_ids"][str(home)], [1, 11, 12])
        self.assertEqual(original, [(row.player_id, row.status, row.goalkeeper) for row in
                         db.session.scalars(select(CupParticipation).where(CupParticipation.match_id == match.id)).all()])

    def test_host_can_finish_penalties_at_zero_tied_or_unequal_attempts_with_audited_undo(self):
        csrf = self.login()
        home, away = self.teams[0].id, self.teams[1].id
        tournament_id, match = self._league_match_fixture(csrf, "early-pens", "review", {
            "period": "shootout", "anchor": None,
        }, [(home, 1, "starter", True), (home, 2, "starter", False),
            (away, 3, "starter", True), (away, 4, "starter", False)])
        match.settings = {"league_shootout": True}
        db.session.commit()
        cup = db.session.get(CupTournament, tournament_id)
        sequence = 0

        def call(suffix, **body):
            nonlocal sequence
            sequence += 1
            payload = {"request_id": f"early-pens-{sequence:04}", "expected_version": cup.version,
                       "expected_match_version": match.version, **body}
            response = self.post(f"/api/cup/host/matches/{match.id}/{suffix}", csrf, payload)
            return response, payload

        def undo_finish():
            history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
            target = next(row for row in reversed(history) if row["action"] == "shootout_finish" and not row["undone"])
            if history[-1]["action"] == "match_finalize":
                blocked = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
                    "request_id": f"no-cascade-{sequence:04}", "expected_version": cup.version,
                    "target_audit_id": target["id"], "cascade": False,
                })
                self.assertEqual(blocked.status_code, 409, blocked.json)
            undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
                "request_id": f"undo-early-{sequence:04}", "expected_version": cup.version,
                "target_audit_id": target["id"], "cascade": True,
            })
            self.assertEqual(undone.status_code, 200, undone.json)
            self.assertIsNone(match.settings.get("shootout_finish"))
            self.assertEqual(match.state, "review")

        invalid, _ = call("shootout/finish", confirm=True)
        self.assertEqual(invalid.status_code, 400)
        zero, body = call("shootout/finish", confirm=True, winner_team_id=away)
        self.assertEqual(zero.status_code, 200, zero.json)
        repeated = self.post(f"/api/cup/host/matches/{match.id}/shootout/finish", csrf, body)
        self.assertEqual(repeated.json, zero.json)
        detail = self.client.get(f"/api/cup/matches/{match.id}").json["match"]
        self.assertEqual((detail["shootout"], detail["shootout_winner_team_id"]), ({"home": 0, "away": 0}, away))
        self.assertTrue(detail["shootout_finish"]["host_decided"])
        self.assertEqual(call("shootout", team_id=home, player_id=1, scored=True)[0].status_code, 409)
        self.assertEqual(call("finalize")[0].status_code, 200)
        table = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]["standings"]
        self.assertEqual({row["id"]: row["points"] for row in table}[away], 3)
        self.assertTrue(all(row["goals_for"] == row["goals_against"] == 0 for row in table))
        undo_finish()
        self.assertEqual(call("shootout", team_id=home, player_id=1, scored=True)[0].status_code, 200)
        wrong, _ = call("shootout/finish", confirm=True, winner_team_id=away)
        self.assertEqual(wrong.status_code, 400)
        leading, _ = call("shootout/finish", confirm=True)
        self.assertEqual(leading.status_code, 200, leading.json)
        self.assertFalse(match.settings["shootout_finish"]["host_decided"])
        self.assertEqual(call("finalize")[0].status_code, 200)
        undo_finish()
        self.assertEqual(call("shootout", team_id=away, player_id=3, scored=True)[0].status_code, 200)
        tied, _ = call("shootout/finish", confirm=True, winner_team_id=home)
        self.assertEqual(tied.status_code, 200, tied.json)
        event = db.session.scalar(select(CupMatchEvent).where(CupMatchEvent.match_id == match.id))
        corrected, _ = call(f"events/{event.id}/correct", scored=False)
        self.assertEqual(corrected.status_code, 409)
        self.assertEqual(call("finalize")[0].status_code, 200)
        self.assertEqual(len(self.client.get(f"/api/cup/matches/{match.id}").json["match"]["events"]), 2)

    def test_tournament_pause_blocks_match_commands_freezes_clock_and_requires_explicit_resume(self):
        csrf = self.login()
        now = datetime.now(timezone.utc)
        tournament_id, match = self._league_match_fixture(csrf, "pause-cup", "live", {
            "period": "first_half", "elapsed_seconds": 5, "anchor": (now - timedelta(seconds=30)).isoformat(),
            "paused": False, "played_seconds": 0,
        }, [(1, 1, "starter", True), (1, 2, "starter", False),
            (2, 3, "starter", True), (2, 4, "starter", False)])
        path = f"/api/cup/host/{tournament_id}/control"
        body = {"request_id": "pause-tournament", "expected_version": 2, "command": "pause"}
        with patch("cup._now", return_value=now):
            paused = self.post(path, csrf, body)
        self.assertEqual(paused.status_code, 200, paused.json)
        self.assertEqual(self.post(path, csrf, body).json, paused.json)
        self.assertEqual((match.state, match.clock["elapsed_seconds"], match.clock["anchor"]), ("paused", 35, None))
        for suffix, extra in (("clock", {"command": "resume"}), ("events", {"event_type": "shot"}),
                              ("lineup", {}), ("finalize", {}), ("shootout/finish", {"confirm": True})):
            blocked = self.post(f"/api/cup/host/matches/{match.id}/{suffix}", csrf, {
                "request_id": f"blocked-{suffix.replace('/', '-')}", "expected_version": 3,
                "expected_match_version": match.version, **extra,
            })
            self.assertEqual(blocked.status_code, 409, blocked.json)
            self.assertIn("paused", blocked.json["error"])
        status = self.client.get("/api/cup/host/requests/pause-tournament")
        self.assertEqual(status.json["status"], "committed")
        with patch("cup._now", return_value=now + timedelta(minutes=10)):
            resumed = self.post(path, csrf, {
                "request_id": "resume-tournament", "expected_version": 3, "command": "resume",
            })
        self.assertEqual(resumed.status_code, 200, resumed.json)
        self.assertEqual((match.state, match.clock["elapsed_seconds"], match.clock["anchor"]), ("paused", 35, None))
        with patch("cup._now", return_value=now + timedelta(minutes=11)):
            match_resumed = self.post(f"/api/cup/host/matches/{match.id}/clock", csrf, {
                "request_id": "explicit-match-resume", "expected_version": 4,
                "expected_match_version": match.version, "command": "resume",
            })
        self.assertEqual(match_resumed.status_code, 200, match_resumed.json)
        self.assertEqual(match.clock["elapsed_seconds"], 35)
        history = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"]
        target = next(row for row in history if row["action"] == "tournament_control")
        undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-paused-tournament", "expected_version": 5,
            "target_audit_id": target["id"], "cascade": True,
        })
        self.assertEqual(undo.status_code, 200, undo.json)
        self.assertEqual((match.state, match.clock["elapsed_seconds"]), ("live", 35))

    def test_tournament_pause_keeps_half_time_reference_frozen_and_review_unchanged(self):
        csrf = self.login()
        now = datetime.now(timezone.utc)
        tournament_id, match = self._league_match_fixture(csrf, "pause-break", "paused", {
            "period": "half_time_break", "elapsed_seconds": 0, "anchor": None, "paused": True,
            "break_started_at": (now - timedelta(seconds=20)).isoformat(), "played_seconds": 400,
        }, [])
        path = f"/api/cup/host/{tournament_id}/control"
        with patch("cup._now", return_value=now):
            self.assertEqual(self.post(path, csrf, {
                "request_id": "pause-break-cup", "expected_version": 2, "command": "pause",
            }).status_code, 200)
        self.assertEqual(match.clock["break_elapsed_seconds"], 20)
        self.assertNotIn("break_started_at", match.clock)
        later = now + timedelta(hours=1)
        with patch("cup._now", return_value=later):
            self.assertEqual(self.post(path, csrf, {
                "request_id": "resume-break-cup", "expected_version": 3, "command": "resume",
            }).status_code, 200)
        self.assertEqual(datetime.fromisoformat(match.clock["break_started_at"]), later - timedelta(seconds=20))
        self.assertEqual((match.state, match.clock["period"], match.clock["played_seconds"]),
                         ("paused", "half_time_break", 400))
        match.state = "review"
        match.clock = {"period": "full_time", "anchor": None, "elapsed_seconds": 12}
        db.session.commit()
        self.assertEqual(self.post(path, csrf, {
            "request_id": "pause-review-cup", "expected_version": 4, "command": "pause",
        }).status_code, 200)
        self.assertEqual((match.state, match.clock["elapsed_seconds"]), ("review", 12))

    def test_final_before_third_place_requires_explicit_tournament_finish_and_can_be_undone(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {"request_id": "create-final-first"})
        tournament_id = created.json["tournament_id"]
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-final-first", "expected_version": 0,
        })
        cup = db.session.get(CupTournament, tournament_id)
        cup.lifecycle = "running"
        games = [
            CupMatch(tournament_id=tournament_id, stage=stage, home_team_id=home,
                     away_team_id=away, match_order=order, state="review",
                     settings={}, version=0, clock={})
            for stage, home, away, order in (("third_place", 3, 4, 11), ("final", 1, 2, 12))
        ]
        db.session.add_all(games)
        db.session.flush()
        for game in games:
            if game.stage == "final":
                game.clock = {"period": "shootout", "paused": True, "anchor": None}
                continue
            db.session.add(CupMatchEvent(
                match_id=game.id, request_id=f"goal-final-first-{game.id}",
                event_type="shot", minute=1, period="first_half", team_id=game.home_team_id,
                player_id=game.home_team_id * 2 - 1, outcome="goal", payload={},
                voided=False, created_at=datetime.now(timezone.utc),
            ))
        db.session.commit()
        award = self.post(f"/api/cup/host/matches/{games[1].id}/shootout/finish", csrf, {
            "request_id": "award-zero-kick-final", "expected_version": imported.json["version"],
            "expected_match_version": 0, "winner_team_id": games[1].away_team_id, "confirm": True,
        })
        self.assertEqual(award.status_code, 200, award.json)
        final = self.post(f"/api/cup/host/matches/{games[1].id}/finalize", csrf, {
            "request_id": "finalize-first", "expected_version": award.json["version"],
            "expected_match_version": award.json["match_version"],
        })
        self.assertEqual(final.status_code, 200, final.json)
        public = self.client.get(f"/api/cup/matches/{games[1].id}").json["match"]
        self.assertEqual(public["shootout_winner_team_id"], games[1].away_team_id)
        self.assertEqual(public["shootout"], {"home": 0, "away": 0})
        self.assertEqual(cup.lifecycle, "running")
        third = self.post(f"/api/cup/host/matches/{games[0].id}/finalize", csrf, {
            "request_id": "finalize-third-after-final", "expected_version": final.json["version"],
            "expected_match_version": 0,
        })
        self.assertEqual(third.status_code, 200, third.json)
        self.assertEqual(cup.lifecycle, "running")
        missing_league = self.post(f"/api/cup/host/{tournament_id}/control", csrf, {
            "request_id": "finish-missing-league", "expected_version": third.json["version"],
            "command": "finish", "confirm": True,
        })
        self.assertEqual(missing_league.status_code, 409, missing_league.json)
        db.session.add_all([
            CupMatch(tournament_id=tournament_id, stage="league", home_team_id=home,
                     away_team_id=away, match_order=order, state="finalized",
                     settings={}, version=0, clock={})
            for order, (home, away) in enumerate(build_league_fixtures([team.id for team in self.teams]), 1)
        ])
        db.session.commit()
        finish = self.post(f"/api/cup/host/{tournament_id}/control", csrf, {
            "request_id": "finish-final-first", "expected_version": third.json["version"],
            "command": "finish", "confirm": True,
        })
        self.assertEqual(finish.status_code, 200, finish.json)
        self.assertEqual(cup.lifecycle, "completed")
        target = self.client.get(f"/api/cup/host/{tournament_id}/history").json["history"][-1]["id"]
        undo = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-third-finalization", "target_audit_id": target,
            "expected_version": finish.json["version"], "cascade": False,
        })
        self.assertEqual(undo.status_code, 200, undo.json)
        self.assertEqual(cup.lifecycle, "running")

    def test_playoff_qualification_shootout_and_finalization_undo(self):
        csrf = self.login()
        created = self.post("/api/cup/host/tournaments", csrf, {
            "request_id": "create-playoff",
        })
        tournament_id = created.json["tournament_id"]
        settings = self.post(f"/api/cup/host/{tournament_id}/settings", csrf, {
            "request_id": "settings-playoff", "expected_version": 0,
            "settings": {"players_per_side": 2, "half_minutes": 1, "break_minutes": 1},
        })
        self.assertEqual(settings.status_code, 200, settings.json)
        imported = self.post(f"/api/cup/host/{tournament_id}/import-squads", csrf, {
            "request_id": "import-playoff", "expected_version": 1,
        })
        self.assertEqual(imported.status_code, 200, imported.json)
        db.session.get(CupTournament, tournament_id).lifecycle = "running"
        db.session.commit()

        finished_at = datetime.now(timezone.utc) - timedelta(hours=6)
        player_by_team = {
            self.teams[index // 2].id: self.players[index].id
            for index in range(len(self.players))
        }
        league_matches = []
        league_events = []
        for order, (home_id, away_id) in enumerate(
            build_league_fixtures([team.id for team in self.teams]), start=1,
        ):
            match = CupMatch(
                tournament_id=tournament_id, stage="league",
                home_team_id=home_id, away_team_id=away_id,
                match_order=order, scheduled_at=finished_at - timedelta(hours=1),
                state="finalized", settings={}, version=0, clock={},
                finalized_at=finished_at,
            )
            league_matches.append(match)
            winner_id = min(home_id, away_id)
            league_events.append((match, winner_id))
        db.session.add_all(league_matches)
        db.session.flush()
        db.session.add_all([
            CupMatchEvent(
                match_id=match.id, request_id=f"league-goal-{index:04}",
                event_type="shot", minute=1, period="first_half", team_id=winner_id,
                player_id=player_by_team[winner_id], outcome="goal", payload={},
                voided=False, created_at=finished_at,
            )
            for index, (match, winner_id) in enumerate(league_events, start=1)
        ])
        db.session.commit()

        kickoff = datetime.now(timezone.utc) - timedelta(hours=3)
        qualified = self.post(f"/api/cup/host/{tournament_id}/playoffs", csrf, {
            "request_id": "qualify-playoffs", "expected_version": 2,
            "kickoff": kickoff.isoformat(),
        })
        self.assertEqual(qualified.status_code, 200, qualified.json)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual([(row["stage"], row["home_team_id"], row["away_team_id"])
                          for row in detail["matches"][-2:]], [
            ("third_place", self.teams[2].id, self.teams[3].id),
            ("final", self.teams[0].id, self.teams[1].id),
        ])
        final = db.session.scalar(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id, CupMatch.stage == "final",
        ))
        third_place = db.session.scalar(select(CupMatch).where(
            CupMatch.tournament_id == tournament_id, CupMatch.stage == "third_place",
        ))
        player_ids = {
            team.id: [player.id for index, player in enumerate(self.players)
                      if self.teams[index // 2].id == team.id]
            for team in (self.teams[0], self.teams[1])
        }
        lineup = self.post(f"/api/cup/host/matches/{final.id}/lineup", csrf, {
            "request_id": "lineup-playoff", "expected_version": 3,
            "expected_match_version": 0, "players": [
                {"player_id": player_id, "team_id": team_id,
                 "status": "starter", "goalkeeper": index == 0}
                for team_id in (final.home_team_id, final.away_team_id)
                for index, player_id in enumerate(player_ids[team_id])
            ],
        })
        self.assertEqual(lineup.status_code, 200, lineup.json)
        rules = self.post(f"/api/cup/host/matches/{final.id}/playoff-rules", csrf, {
            "request_id": "rules-playoff", "expected_version": 4,
            "expected_match_version": 1, "draw_method": "direct_penalties",
            "extra_time_minutes": 0, "shootout_kicks": 5,
            "shootout_taker_rule": "equal_players_only",
        })
        self.assertEqual(rules.status_code, 200, rules.json)
        league_matches[0].state = "scheduled"
        db.session.commit()
        premature_playoff = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
            "request_id": "kickoff-before-league-complete", "expected_version": 5,
            "expected_match_version": 2, "command": "kickoff",
        })
        self.assertEqual(premature_playoff.status_code, 409)
        self.assertIn("ten league matches", premature_playoff.json["error"])
        league_matches[0].state = "finalized"
        original_home = final.home_team_id
        final.home_team_id = self.teams[4].id
        db.session.commit()
        wrong_qualifier = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
            "request_id": "kickoff-wrong-qualifier", "expected_version": 5,
            "expected_match_version": 2, "command": "kickoff",
        })
        self.assertEqual(wrong_qualifier.status_code, 409)
        self.assertIn("qualified league standings", wrong_qualifier.json["error"])
        final.home_team_id = original_home
        db.session.commit()
        kickoff_result = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
            "request_id": "kickoff-playoff", "expected_version": 5,
            "expected_match_version": 2, "command": "kickoff",
        })
        self.assertEqual(kickoff_result.status_code, 200, kickoff_result.json)
        third_place.state = "finalized"
        third_place.finalized_at = finished_at
        db.session.commit()
        first_anchor = datetime.fromisoformat(kickoff_result.json["clock"]["anchor"])
        with patch("cup._now", return_value=first_anchor + timedelta(seconds=20)):
            first_period = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
                "request_id": "first-period-before-target", "expected_version": 6,
                "expected_match_version": 3, "command": "end_period",
            })
        self.assertEqual(first_period.status_code, 200, first_period.json)
        self.assertEqual(first_period.json["clock"]["period"], "half_time_break")
        during_break = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
            "request_id": "end-during-break", "expected_version": 7,
            "expected_match_version": 4, "command": "end_period",
        })
        self.assertEqual(during_break.status_code, 409, during_break.json)
        break_anchor = datetime.fromisoformat(first_period.json["clock"]["break_started_at"])
        with patch("cup._now", return_value=break_anchor + timedelta(seconds=5)):
            resumed = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
                "request_id": "resume-second-before-break-target", "expected_version": 7,
                "expected_match_version": 4, "command": "resume",
            })
        self.assertEqual(resumed.status_code, 200, resumed.json)
        self.assertEqual(resumed.json["clock"]["period"], "second_half")
        self.assertEqual(resumed.json["clock"]["elapsed_seconds"], 0)
        second_anchor = datetime.fromisoformat(resumed.json["clock"]["anchor"])
        overtime = second_anchor + timedelta(minutes=4)
        with patch("cup._now", return_value=overtime):
            second_period = self.post(f"/api/cup/host/matches/{final.id}/clock", csrf, {
                "request_id": "second-period", "expected_version": 8,
                "expected_match_version": 5, "command": "end_period",
            })
        self.assertEqual(second_period.status_code, 200, second_period.json)
        self.assertEqual(second_period.json["match_state"], "review")
        self.assertEqual(second_period.json["clock"]["period"], "shootout")

        match_version, tournament_version = 6, 9
        last_attempt = None
        for team_id, scored in ((final.home_team_id, True), (final.away_team_id, False)):
            last_attempt = self.post(f"/api/cup/host/matches/{final.id}/shootout", csrf, {
                "request_id": f"penalty-first-{team_id}",
                "expected_version": tournament_version,
                "expected_match_version": match_version,
                "team_id": team_id, "player_id": player_ids[team_id][0], "scored": scored,
            })
            self.assertEqual(last_attempt.status_code, 200, last_attempt.json)
            tournament_version += 1
            match_version += 1
        repeated_taker = self.post(f"/api/cup/host/matches/{final.id}/shootout", csrf, {
            "request_id": "penalty-repeat-too-soon",
            "expected_version": tournament_version,
            "expected_match_version": match_version,
            "team_id": final.home_team_id, "player_id": player_ids[final.home_team_id][0],
            "scored": True,
        })
        self.assertEqual(repeated_taker.status_code, 409)

        for attempt in range(1, 3):
            for team_id, scored in ((final.home_team_id, True), (final.away_team_id, False)):
                last_attempt = self.post(f"/api/cup/host/matches/{final.id}/shootout", csrf, {
                    "request_id": f"penalty-{attempt}-{team_id}",
                    "expected_version": tournament_version,
                    "expected_match_version": match_version,
                    "team_id": team_id, "player_id": player_ids[team_id][attempt % 2],
                    "scored": scored,
                })
                self.assertEqual(last_attempt.status_code, 200, last_attempt.json)
                tournament_version += 1
                match_version += 1

        finalized = self.post(f"/api/cup/host/matches/{final.id}/finalize", csrf, {
            "request_id": "finalize-playoff", "expected_version": tournament_version,
            "expected_match_version": match_version,
        })
        self.assertEqual(finalized.status_code, 200, finalized.json)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(detail["lifecycle"], "running")
        self.assertEqual(detail["matches"][-1]["state"], "finalized")
        self.assertEqual(detail["matches"][-1]["shootout"], {"home": 3, "away": 0})
        attempt = next(row for row in detail["matches"][-1]["events"] if row["event_type"] == "shootout"
                       and row["team_id"] == final.away_team_id)
        invalid_result = self.post(f"/api/cup/host/matches/{final.id}/events/{attempt['id']}/correct", csrf, {
            "request_id": "invalid-shootout-correction", "expected_version": tournament_version + 1,
            "expected_match_version": match_version + 1, "confirm_finalized": True, "scored": True,
        })
        self.assertEqual(invalid_result.status_code, 409, invalid_result.json)

        finalization_audit_id = self.client.get(
            f"/api/cup/host/{tournament_id}/history"
        ).json["history"][-1]["id"]
        finished = self.post(f"/api/cup/host/{tournament_id}/control", csrf, {
            "request_id": "explicit-finish-playoffs", "expected_version": finalized.json["version"],
            "command": "finish", "confirm": True,
        })
        self.assertEqual(finished.status_code, 200, finished.json)
        self.assertEqual(db.session.get(CupTournament, tournament_id).lifecycle, "completed")
        preview = self.client.get(
            f"/api/cup/host/{tournament_id}/undo-preview?target_audit_id={finalization_audit_id}"
        ).json
        undone = self.post(f"/api/cup/host/{tournament_id}/undo", csrf, {
            "request_id": "undo-finalize", "target_audit_id": finalization_audit_id,
            "expected_version": preview["expected_version"], "cascade": True,
        })
        self.assertEqual(undone.status_code, 200, undone.json)
        detail = self.client.get(f"/api/cup/{tournament_id}").json["tournament"]
        self.assertEqual(detail["lifecycle"], "running")
        self.assertEqual(detail["matches"][-1]["state"], "review")


if __name__ == "__main__":
    unittest.main()
