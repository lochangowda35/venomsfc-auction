import unittest
from datetime import datetime, timezone

from cup_rules import (
    aggregate_player_statistics,
    build_league_fixtures,
    compute_standings,
    match_score,
    qualification_scenarios,
    schedule_fixtures,
)


class FixtureRuleTests(unittest.TestCase):
    def test_round_robin_has_exact_coverage_and_no_consecutive_teams(self):
        team_ids = [40, 10, 50, 20, 30]
        fixtures = build_league_fixtures(team_ids)

        self.assertEqual(len(fixtures), 10)
        self.assertEqual(len({frozenset(pair) for pair in fixtures}), 10)
        self.assertEqual(
            {team_id: sum(team_id in pair for pair in fixtures) for team_id in team_ids},
            {team_id: 4 for team_id in team_ids},
        )
        for previous, current in zip(fixtures, fixtures[1:]):
            self.assertFalse(set(previous) & set(current))

    def test_round_robin_requires_five_distinct_teams(self):
        with self.assertRaises(ValueError):
            build_league_fixtures([1, 2, 3, 4])
        with self.assertRaises(ValueError):
            build_league_fixtures([1, 2, 3, 4, 4])

    def test_schedule_uses_match_and_rest_duration(self):
        kickoff = datetime(2026, 11, 9, 10, tzinfo=timezone.utc)
        scheduled = schedule_fixtures([1, 2, 3, 4, 5], kickoff, 25, 15)

        self.assertEqual(len(scheduled), 10)
        self.assertEqual(scheduled[1]["scheduled_at"].minute, 40)
        self.assertEqual(scheduled[-1]["match_order"], 10)


class MatchStatisticsTests(unittest.TestCase):
    def test_scores_ignore_voided_events_and_credit_own_goals_to_opponent(self):
        events = [
            {"event_type": "shot", "outcome": "goal", "team_id": 1},
            {"event_type": "own_goal", "team_id": 2},
            {"event_type": "shot", "outcome": "goal", "team_id": 2, "voided": True},
        ]

        self.assertEqual(match_score(events, 1, 2), {1: 2, 2: 0})

    def test_goal_and_save_shots_are_counted_once(self):
        stats = aggregate_player_statistics([
            {"event_type": "shot", "outcome": "goal", "player_id": 1, "assist_player_id": 2},
            {"event_type": "shot", "outcome": "saved", "player_id": 1, "goalkeeper_id": 3},
            {"event_type": "shot", "outcome": "blocked", "player_id": 1},
            {"event_type": "shot", "outcome": "off_target", "player_id": 1},
            {"event_type": "shot", "outcome": "saved", "player_id": 4, "goalkeeper_id": 3,
             "voided": True},
        ])
        by_player = {row["player_id"]: row for row in stats}

        self.assertEqual(by_player[1]["goals"], 1)
        self.assertEqual(by_player[1]["shots"], 4)
        self.assertEqual(by_player[1]["shots_on_target"], 2)
        self.assertEqual(by_player[2]["assists"], 1)
        self.assertEqual(by_player[3]["saves"], 1)

    def test_league_table_uses_only_finalized_matches_and_requires_tie_resolution(self):
        teams = [{"id": team_id, "name": f"Team {team_id}"} for team_id in (1, 2)]
        matches = [
            {"stage": "league", "state": "finalized", "home_team_id": 1,
             "away_team_id": 2, "home_goals": 1, "away_goals": 0},
            {"stage": "final", "state": "finalized", "home_team_id": 2,
             "away_team_id": 1, "home_goals": 8, "away_goals": 0},
            {"stage": "league", "state": "live", "home_team_id": 2,
             "away_team_id": 1, "home_goals": 5, "away_goals": 0},
        ]
        table = compute_standings(teams, matches)

        self.assertEqual([row["id"] for row in table], [1, 2])
        self.assertEqual([row["points"] for row in table], [3, 0])
        matches[0].update(home_goals=0, away_goals=0)
        with self.assertRaisesRegex(ValueError, "ranking decision"):
            compute_standings(teams, matches)
        resolved = compute_standings(teams, matches, [[2, 1]])
        self.assertEqual([row["id"] for row in resolved], [2, 1])
        self.assertEqual([row["rank"] for row in resolved], [1, 2])
        with self.assertRaisesRegex(ValueError, "ranking decision"):
            compute_standings(teams, matches, [[2, 2]])
        unresolved = compute_standings(teams, matches, allow_unresolved=True)
        self.assertEqual([row["rank"] for row in unresolved], [1, 1])

    def test_second_yellow_counts_once_as_a_red_dismissal(self):
        stats = aggregate_player_statistics([
            {"event_type": "yellow_card", "player_id": 1, "payload": {}},
            {"event_type": "yellow_card", "player_id": 1,
             "payload": {"second_yellow_dismissal": True}},
            {"event_type": "red_card", "player_id": 2, "payload": {}},
        ])
        by_player = {row["player_id"]: row for row in stats}
        self.assertEqual(by_player[1]["yellow_cards"], 2)
        self.assertEqual(by_player[1]["red_cards"], 1)
        self.assertEqual(by_player[1]["second_yellow_reds"], 1)
        self.assertEqual(by_player[2]["red_cards"], 1)
        self.assertEqual(by_player[2]["second_yellow_reds"], 0)


def _league(index, home, away, home_goals=0, away_goals=0, state="finalized", shootout_winner=None):
    return {"id": index, "stage": "league", "state": state, "home_team_id": home, "away_team_id": away,
            "home_goals": home_goals, "away_goals": away_goals, "shootout_winner_team_id": shootout_winner}


class QualificationScenarioTests(unittest.TestCase):
    teams = [{"id": index, "name": name} for index, name in enumerate("ABCDE", 1)]

    def scenarios(self, matches):
        return qualification_scenarios(compute_standings(self.teams, matches, allow_unresolved=True), matches)

    def test_hidden_until_every_team_has_two_finalized_league_games(self):
        matches = [_league(1, 1, 2, 2, 0), _league(2, 3, 4, 1, 0), _league(3, 1, 5, 1, 0),
                   _league(4, 2, 3, 0, 0, shootout_winner=2), _league(5, 4, 5, 1, 1, state="live")]
        self.assertIsNone(self.scenarios(matches))

    def test_points_ranges_guarantees_and_shootout_points(self):
        matches = [_league(1, 1, 2, 2, 0), _league(2, 3, 4, 1, 0), _league(3, 1, 5, 1, 0),
                   _league(4, 2, 3, 0, 0, shootout_winner=2), _league(5, 4, 5, 1, 1),
                   _league(6, 1, 3, state="scheduled"), _league(7, 2, 4, state="scheduled"),
                   _league(8, 3, 5, state="scheduled"), _league(9, 1, 4, state="scheduled"),
                   _league(10, 2, 5, state="review")]
        result = self.scenarios(matches)
        by_team = {row["team_id"]: row for row in result["teams"]}
        self.assertEqual(len(result["remaining_matches"]), 5)
        self.assertEqual((by_team[2]["points"], by_team[3]["points"]), (3, 3))
        self.assertEqual((by_team[1]["points"], by_team[1]["max_points"], by_team[1]["games_left"]), (6, 12, 2))
        self.assertEqual((by_team[1]["best_position"], by_team[1]["worst_position"]), (1, 4))
        self.assertEqual(by_team[1]["playoff"]["status"], "secured")
        self.assertEqual((by_team[1]["final"]["status"], by_team[1]["final"]["secure_points"]), ("possible", 4))
        self.assertIsNone(by_team[3]["final"]["secure_points"])
        self.assertEqual(by_team[5]["final"]["alive_min_points"], 4)

    def test_completed_league_reports_level_teams_as_tiebreak_dependent(self):
        matches = [_league(1, 1, 2, 1, 0), _league(2, 3, 4, 1, 0), _league(3, 1, 5, 1, 0),
                   _league(4, 2, 3, 0, 0), _league(5, 4, 5, 0, 1), _league(6, 1, 3, 1, 0),
                   _league(7, 2, 4, 1, 0), _league(8, 3, 5, 1, 0), _league(9, 1, 4, 1, 0),
                   _league(10, 2, 5, 1, 0)]
        by_team = {row["team_id"]: row for row in self.scenarios(matches)["teams"]}
        self.assertEqual(by_team[1]["final"]["status"], "secured")
        self.assertEqual((by_team[2]["final"]["status"], by_team[3]["final"]["status"]), ("tiebreak", "tiebreak"))
        self.assertEqual(by_team[4]["playoff"]["status"], "eliminated")
        self.assertEqual(by_team[5]["playoff"]["status"], "secured")


if __name__ == "__main__":
    unittest.main()
