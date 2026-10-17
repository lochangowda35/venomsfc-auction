import unittest

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import create_app
from extensions import db
from models import Player, Team


class ProfileModelTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
        })
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
        self.context.pop()

    def test_team_and_player_profiles_round_trip(self):
        team = Team(name="Venoms", logo_path="teams/venoms.png")
        player = Player(
            name="Example Player", photo_path="players/example.jpg", position="Midfielder"
        )
        db.session.add_all([team, player])
        db.session.commit()
        db.session.expire_all()

        saved_team = db.session.execute(select(Team)).scalar_one()
        saved_player = db.session.execute(select(Player)).scalar_one()
        self.assertIsNotNone(saved_team.id)
        self.assertEqual(saved_team.name, "Venoms")
        self.assertEqual(saved_team.logo_path, "teams/venoms.png")
        self.assertIsNotNone(saved_player.id)
        self.assertEqual(saved_player.name, "Example Player")
        self.assertEqual(saved_player.photo_path, "players/example.jpg")
        self.assertEqual(saved_player.position, "Midfielder")

    def test_required_fields_reject_null_and_blank_values(self):
        profiles = (
            (Team, {"name": "Venoms", "logo_path": "teams/venoms.png"}),
            (Player, {
                "name": "Player",
                "photo_path": "players/player.jpg",
                "position": "Goalkeeper",
            }),
        )
        for model, fields in profiles:
            for field in fields:
                for invalid in (None, "", "   "):
                    with self.subTest(model=model.__name__, field=field, value=invalid):
                        db.session.add(model(**{**fields, field: invalid}))
                        with self.assertRaises(IntegrityError):
                            db.session.commit()
                        db.session.rollback()

    def test_players_with_same_name_remain_distinct(self):
        for position in ("Defender", "Forward"):
            db.session.add(Player(
                name="Same Name", photo_path="players/example.jpg", position=position
            ))
        db.session.commit()

        players = db.session.execute(select(Player)).scalars().all()
        self.assertEqual(len(players), 2)
        self.assertNotEqual(players[0].id, players[1].id)


if __name__ == "__main__":
    unittest.main()
