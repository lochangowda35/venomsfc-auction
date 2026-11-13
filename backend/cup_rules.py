"""Pure Internal Cup rules used by the API and disposable tests."""

import itertools
from datetime import timedelta


FIXTURE_ORDER = (
    ("A", "B"),
    ("C", "D"),
    ("A", "E"),
    ("B", "C"),
    ("D", "E"),
    ("A", "C"),
    ("B", "D"),
    ("C", "E"),
    ("A", "D"),
    ("B", "E"),
)

SHOT_OUTCOMES = {"goal", "saved", "off_target", "blocked"}
PERIODS = {"first_half", "second_half", "extra_time_1", "extra_time_2"}


def build_league_fixtures(team_ids):
    """Return one deterministic, non-consecutive round robin for five teams."""
    ordered = sorted(team_ids)
    if len(ordered) != 5 or len(set(ordered)) != 5:
        raise ValueError("Exactly five distinct teams are required.")
    labels = dict(zip("ABCDE", ordered))
    fixtures = [(labels[left], labels[right]) for left, right in FIXTURE_ORDER]
    for previous, current in zip(fixtures, fixtures[1:]):
        if set(previous) & set(current):
            raise ValueError("Fixture order contains a team in consecutive matches.")
    return fixtures


def schedule_fixtures(team_ids, kickoff, match_minutes, rest_minutes):
    if match_minutes < 1 or rest_minutes < 0:
        raise ValueError("Match and rest durations are invalid.")
    fixtures = build_league_fixtures(team_ids)
    gap = timedelta(minutes=match_minutes + rest_minutes)
    return [
        {"home_team_id": home, "away_team_id": away, "match_order": index + 1,
         "scheduled_at": kickoff + index * gap}
        for index, (home, away) in enumerate(fixtures)
    ]


def match_score(events, home_team_id, away_team_id):
    goals = {home_team_id: 0, away_team_id: 0}
    for event in events:
        if event.get("voided"):
            continue
        if event.get("event_type") == "shot" and event.get("outcome") == "goal":
            team_id = event.get("team_id")
        elif event.get("event_type") == "own_goal":
            team_id = away_team_id if event.get("team_id") == home_team_id else home_team_id
        else:
            continue
        if team_id not in goals:
            raise ValueError("A goal event references a team outside the match.")
        goals[team_id] += 1
    return goals


def compute_standings(teams, matches, tie_resolution=None, allow_unresolved=False):
    """Rank finalized league games; exact sporting ties require explicit host order."""
    tie_resolution = tie_resolution or []
    stats = {
        team["id"]: {
            **team, "played": 0, "won": 0, "drawn": 0, "lost": 0,
            "goals_for": 0, "goals_against": 0, "goal_difference": 0, "points": 0,
        }
        for team in teams
    }
    for match in matches:
        if match.get("stage") != "league" or match.get("state") != "finalized":
            continue
        home, away = match["home_team_id"], match["away_team_id"]
        if home not in stats or away not in stats:
            continue
        home_goals, away_goals = match["home_goals"], match["away_goals"]
        shootout_winner = match.get("shootout_winner_team_id") if home_goals == away_goals else None
        for team_id, scored, conceded in (
            (home, home_goals, away_goals), (away, away_goals, home_goals),
        ):
            row = stats[team_id]
            row["played"] += 1
            row["goals_for"] += scored
            row["goals_against"] += conceded
            row["goal_difference"] += scored - conceded
            won = scored > conceded or shootout_winner == team_id
            lost = scored < conceded or (shootout_winner is not None and shootout_winner != team_id)
            row["points"] += 3 if won else 0 if lost else 1
            row["won"] += int(won)
            row["drawn"] += int(not won and not lost)
            row["lost"] += int(lost)

    rank_key = lambda row: (-row["points"], -row["goal_difference"], -row["goals_for"])
    ordered = sorted(stats.values(), key=rank_key)
    groups = []
    for row in ordered:
        if not groups or rank_key(groups[-1][0]) != rank_key(row):
            groups.append([row])
        else:
            groups[-1].append(row)
    resolved = []
    resolution_index = 0
    rank = 1
    for group in groups:
        group_resolved = len(group) == 1
        if len(group) > 1:
            chosen = tie_resolution[resolution_index] if resolution_index < len(tie_resolution) else []
            if (
                len(chosen) == len(group)
                and len(set(chosen)) == len(chosen)
                and set(chosen) == {row["id"] for row in group}
            ):
                positions = {team_id: index for index, team_id in enumerate(chosen)}
                group.sort(key=lambda row: positions[row["id"]])
                group_resolved = True
            elif not allow_unresolved:
                raise ValueError("A host ranking decision is required to resolve the tied teams.")
            resolution_index += 1
        for index, row in enumerate(group):
            resolved.append({**row, "rank": rank + index if group_resolved else rank})
        rank += len(group)
    return resolved


QUALIFICATION_SLOTS = (("final", 2), ("playoff", 4))


def qualification_scenarios(standings, matches, minimum_played=2):
    """Points-only finishing ranges once every team has enough finalized league games.

    Each remaining league fixture yields 3/0, 1/1 or 0/3 points (a draw settled on
    penalties is worth the same as a win). Future scorelines are unknown, so a
    position that relies on finishing level on points is reported as tie-dependent.
    """
    if not standings or any(row["played"] < minimum_played for row in standings):
        return None
    team_ids = [row["id"] for row in standings]
    remaining = [
        match for match in matches
        if match.get("stage") == "league" and match.get("state") != "finalized"
        and match.get("home_team_id") in team_ids and match.get("away_team_id") in team_ids
    ]
    if len(remaining) > 10:
        return None
    base = {row["id"]: row["points"] for row in standings}
    games_left = {team_id: 0 for team_id in team_ids}
    for match in remaining:
        games_left[match["home_team_id"]] += 1
        games_left[match["away_team_id"]] += 1
    summary = {team_id: {"best": len(team_ids), "worst": 1, "outcomes": []} for team_id in team_ids}
    for results in itertools.product(((3, 0), (1, 1), (0, 3)), repeat=len(remaining)):
        points = dict(base)
        gained = {team_id: 0 for team_id in team_ids}
        for match, (home_points, away_points) in zip(remaining, results):
            points[match["home_team_id"]] += home_points
            points[match["away_team_id"]] += away_points
            gained[match["home_team_id"]] += home_points
            gained[match["away_team_id"]] += away_points
        for team_id in team_ids:
            above = sum(1 for other in team_ids if other != team_id and points[other] > points[team_id])
            level = sum(1 for other in team_ids if other != team_id and points[other] == points[team_id])
            best, worst = above + 1, above + level + 1
            row = summary[team_id]
            row["best"] = min(row["best"], best)
            row["worst"] = max(row["worst"], worst)
            row["outcomes"].append((gained[team_id], best, worst))
    teams = []
    for standing in standings:
        row = summary[standing["id"]]
        outcomes = row["outcomes"]
        entry = {
            "team_id": standing["id"], "name": standing["name"], "points": standing["points"],
            "games_left": games_left[standing["id"]],
            "max_points": standing["points"] + 3 * games_left[standing["id"]],
            "best_position": row["best"], "worst_position": row["worst"],
        }
        for key, places in QUALIFICATION_SLOTS:
            if all(worst <= places for _, _, worst in outcomes):
                status = "secured"
            elif any(worst <= places for _, _, worst in outcomes):
                status = "possible"
            elif any(best <= places for _, best, _ in outcomes):
                status = "tiebreak"
            else:
                status = "eliminated"
            achievable = sorted({gained for gained, _, _ in outcomes})
            secure_points = next((
                points for points in achievable
                if all(worst <= places for gained, _, worst in outcomes if gained >= points)
            ), None)
            outright = [gained for gained, _, worst in outcomes if worst <= places]
            alive = [gained for gained, best, _ in outcomes if best <= places]
            entry[key] = {
                "status": status,
                "secure_points": secure_points,
                "outright_min_points": min(outright) if outright else None,
                "alive_min_points": min(alive) if alive else None,
            }
        teams.append(entry)
    return {
        "minimum_played": minimum_played,
        "remaining_matches": [
            {"id": match["id"], "home_team_id": match["home_team_id"], "away_team_id": match["away_team_id"]}
            for match in remaining
        ],
        "teams": teams,
    }


def aggregate_player_statistics(events):
    totals = {}
    for event in events:
        if event.get("voided"):
            continue
        event_type = event.get("event_type")
        player_id = event.get("player_id")
        if player_id is None:
            continue
        row = totals.setdefault(player_id, {
            "player_id": player_id, "goals": 0, "assists": 0, "shots": 0,
            "shots_on_target": 0, "saves": 0, "own_goals": 0,
            "yellow_cards": 0, "red_cards": 0, "second_yellow_reds": 0,
        })
        if event_type == "shot":
            row["shots"] += 1
            if event.get("outcome") in {"goal", "saved"}:
                row["shots_on_target"] += 1
            if event.get("outcome") == "goal":
                row["goals"] += 1
                assist_id = event.get("assist_player_id")
                if assist_id is not None:
                    totals.setdefault(assist_id, {
                        "player_id": assist_id, "goals": 0, "assists": 0, "shots": 0,
                        "shots_on_target": 0, "saves": 0, "own_goals": 0,
                        "yellow_cards": 0, "red_cards": 0, "second_yellow_reds": 0,
                    })["assists"] += 1
            if event.get("outcome") == "saved" and event.get("goalkeeper_id") is not None:
                keeper = event["goalkeeper_id"]
                totals.setdefault(keeper, {
                    "player_id": keeper, "goals": 0, "assists": 0, "shots": 0,
                    "shots_on_target": 0, "saves": 0, "own_goals": 0,
                    "yellow_cards": 0, "red_cards": 0, "second_yellow_reds": 0,
                })["saves"] += 1
        elif event_type == "own_goal":
            row["own_goals"] += 1
        elif event_type == "yellow_card":
            row["yellow_cards"] += 1
        elif event_type == "red_card":
            row["red_cards"] += 1
        if event_type == "yellow_card" and event.get("payload", {}).get("second_yellow_dismissal"):
            row["red_cards"] += 1
            row["second_yellow_reds"] += 1
    return list(totals.values())
