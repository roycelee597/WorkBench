"""合成事件覆盖高光判定及其时间窗口边界。"""

from dataclasses import replace

import pytest

from cs2_engine.models import AliveState, Demo, Kill, Player, Round, Shot
from cs2_engine.rules import HIGHLIGHT_TYPES, Rules, parse_rules
from cs2_engine.scoring import HighlightPreview, score_demo

TARGET = "target"
TEAMMATE = "teammate"
ENEMIES = ("enemy-a", "enemy-b", "enemy-c", "enemy-d", "enemy-e")
TICK_RATE = 10.0
DEFAULT_RULES = Rules()


def enemy_kill(tick: int, victim: str, weapon: str = "ak47") -> Kill:
    return Kill(tick, TARGET, victim, 2, 3, weapon)


def score(
    *rounds: Round,
    types: tuple[str, ...] = HIGHLIGHT_TYPES,
    rules: Rules = DEFAULT_RULES,
    victim_pov: bool = False,
) -> list[HighlightPreview]:
    demo = Demo(TICK_RATE, (Player(TARGET, "合成玩家"),), rounds)
    return score_demo(demo, TARGET, types, rules, victim_pov=victim_pov)


def windows(clips: list[HighlightPreview]) -> list[tuple[int, int, int]]:
    return [(clip["round"], clip["start_tick"], clip["end_tick"]) for clip in clips]


def test_merges_types_and_keeps_victim_povs_in_kill_order():
    first = replace(enemy_kill(200, ENEMIES[0], "knife_karambit"), penetrated=1)
    second = enemy_kill(223, ENEMIES[1], "taser")
    third = enemy_kill(270, ENEMIES[2])
    round_ = Round(1, 100, 600, 2, (first, second, third))

    clips = score(round_, victim_pov=True)

    assert windows(clips) == [(1, 170, 285)]
    assert clips[0]["duration_s"] == 11.5
    assert set(clips[0]["types"]) == {"multikill", "quick_kills", "special", "knife", "zeus"}
    assert set(clips[0]["tags"]) == {"3K", "quick_kills", "wallbang", "knife", "zeus"}
    assert clips[0]["victim_povs"] == [
        {
            "steamid64": victim,
            "death_tick": tick,
            "start_tick": tick - 20,
            "end_tick": tick + 5,
            "duration_s": 2.5,
        }
        for victim, tick in zip(ENEMIES[:3], (200, 223, 270), strict=True)
    ]
    assert score(round_)[0]["victim_povs"] == []


def test_ignores_teamkills_suicides_unknown_teams_and_other_players():
    enemy = enemy_kill(205, ENEMIES[0], "knife")
    kills = (
        enemy,
        replace(enemy, tick=207, victim_id=TEAMMATE, victim_team=2),
        replace(enemy, tick=209, victim_id=TARGET),
        replace(enemy, tick=212, victim_id=ENEMIES[1], victim_team=None),
        replace(enemy, tick=216, attacker_id=TEAMMATE, victim_id=ENEMIES[2]),
    )
    round_ = Round(1, 100, 600, 2, kills)

    clips = score(round_, victim_pov=True)

    assert windows(clips) == [(1, 175, 220)]
    assert set(clips[0]["types"]) == {"knife", "special"}
    assert [pov["steamid64"] for pov in clips[0]["victim_povs"]] == [ENEMIES[0]]


@pytest.mark.parametrize(("kill_count", "tag"), [(3, "3K"), (4, "4K"), (5, "ACE")])
def test_multikill_covers_first_to_last_kill(kill_count, tag):
    kills = tuple(enemy_kill(200 + i * 70, ENEMIES[i]) for i in range(kill_count))
    round_ = Round(1, 100, 600, 2, kills)

    clips = score(round_, types=("multikill",))

    assert windows(clips) == [(1, 170, kills[-1].tick + 15)]
    assert clips[0]["tags"] == [tag]


def test_duplicate_kill_rows_do_not_inflate_counts_or_duplicate_povs():
    first = enemy_kill(200, ENEMIES[0], "knife")
    second = enemy_kill(220, ENEMIES[1], "taser")
    round_ = Round(1, 100, 600, 2, (first, first, second))

    clips = score(round_, victim_pov=True)

    assert windows(clips) == [(1, 170, 235)]
    assert "multikill" not in clips[0]["types"]
    assert [pov["steamid64"] for pov in clips[0]["victim_povs"]] == list(ENEMIES[:2])


@pytest.mark.parametrize(("second_tick", "expected"), [(230, [(1, 170, 245)]), (231, [])])
def test_quick_kills_include_exact_window_limit(second_tick, expected):
    kills = (enemy_kill(200, ENEMIES[0]), enemy_kill(second_tick, ENEMIES[1]))
    round_ = Round(1, 100, 600, 2, kills)

    assert windows(score(round_, types=("quick_kills",))) == expected


def test_fractional_configured_window_keeps_exact_tick_boundary():
    kills = (enemy_kill(200, ENEMIES[0]), enemy_kill(229, ENEMIES[1]))
    round_ = Round(1, 100, 600, 2, kills)
    demo = Demo(100.0, (Player(TARGET, "合成玩家"),), (round_,))
    rules = parse_rules({"quick_kills_window_s": 0.29, "pre_s": 0, "post_s": 0})

    assert windows(score_demo(demo, TARGET, ("quick_kills",), rules)) == [(1, 200, 229)]


@pytest.mark.parametrize(
    ("weapon", "flags", "category", "tag"),
    [
        ("ak47", {"penetrated": 2}, "special", "wallbang"),
        ("ak47", {"attacker_in_air": True}, "special", "airborne"),
        ("ak47", {"attacker_blind": True}, "special", "blind"),
        ("ak47", {"through_smoke": True}, "special", "through_smoke"),
        ("knife_m9_bayonet", {}, "knife", "knife"),
        ("taser", {}, "zeus", "zeus"),
        ("awp", {"noscope": True}, "noscope", "noscope"),
        ("ssg08", {"noscope": True}, "noscope", "noscope"),
    ],
)
def test_individual_kill_types(weapon, flags, category, tag):
    kill = replace(enemy_kill(200, ENEMIES[0], weapon), **flags)
    round_ = Round(1, 100, 600, 2, (kill,))

    clips = score(round_, types=(category,))

    assert windows(clips) == [(1, 170, 215)]
    assert tag in clips[0]["tags"]


def test_selected_category_controls_windows_but_matching_tags_are_retained():
    first = enemy_kill(192, ENEMIES[0])
    second = replace(enemy_kill(225, ENEMIES[1], "ssg08"), noscope=True, penetrated=1)
    round_ = Round(1, 100, 600, 2, (first, second))
    rules = parse_rules({"quick_kills_window_s": 4})

    clips = score(round_, types=("noscope",), rules=rules, victim_pov=True)

    assert windows(clips) == [(1, 195, 240)]
    assert {"noscope", "wallbang"}.issubset(clips[0]["tags"])
    assert [pov["steamid64"] for pov in clips[0]["victim_povs"]] == [ENEMIES[1]]
    assert score(round_, types=()) == []


@pytest.mark.parametrize("weapon", ["ak47", "deagle"])
def test_onetap_requires_single_matching_fire_event(weapon):
    kill = replace(enemy_kill(200, ENEMIES[0], weapon), headshot=True)
    round_ = Round(1, 100, 600, 2, (kill,))
    shot = Shot(200, TARGET, weapon)
    unrelated = (Shot(189, TARGET, weapon), Shot(197, TEAMMATE, weapon), Shot(196, TARGET, "glock"))

    clips = score(replace(round_, shots=(*unrelated, shot)), types=("onetap",))

    assert clips[0]["tags"] == ["onetap"]
    no_fire = score(replace(round_, shots=unrelated), types=("onetap",))
    two_fires = score(replace(round_, shots=(Shot(190, TARGET, weapon), shot)), types=("onetap",))
    bodyshot = score(
        replace(round_, kills=(replace(kill, headshot=False),), shots=(shot,)), types=("onetap",)
    )
    assert no_fire == two_fires == bodyshot == []


@pytest.mark.parametrize(
    ("enemy_count", "winner", "expected"),
    [(2, 2, [(1, 190, 380)]), (1, 2, []), (2, 3, []), (2, None, [])],
)
def test_clutch_requires_becoming_last_alive_with_multiple_enemies_and_winning(
    enemy_count, winner, expected
):
    states = (
        AliveState(100, {2: frozenset((TARGET, TEAMMATE)), 3: frozenset(ENEMIES[:3])}),
        AliveState(190, {2: frozenset((TARGET,)), 3: frozenset(ENEMIES[:enemy_count])}),
    )
    kills = (enemy_kill(140, ENEMIES[2]), enemy_kill(220, ENEMIES[0]))
    round_ = Round(1, 100, 380, winner, kills, alive_states=states)

    clips = score(round_, types=("clutch",), victim_pov=True)

    assert windows(clips) == expected
    if expected:
        assert clips[0]["tags"] == ["1v2"]
        assert [pov["steamid64"] for pov in clips[0]["victim_povs"]] == [ENEMIES[0]]


def test_clutch_can_be_won_by_objective_without_a_kill():
    state = AliveState(190, {2: frozenset((TARGET,)), 3: frozenset(ENEMIES[:2])})
    round_ = Round(1, 100, 380, 2, alive_states=(state,))

    clips = score(round_, types=("clutch",), victim_pov=True)

    assert windows(clips) == [(1, 190, 380)]
    assert clips[0]["victim_povs"] == []


def test_long_clutch_keeps_only_windows_for_kills_during_clutch():
    state = AliveState(150, {2: frozenset((TARGET,)), 3: frozenset(ENEMIES[:2])})
    kills = (enemy_kill(120, ENEMIES[2]), enemy_kill(220, ENEMIES[0]), enemy_kill(390, ENEMIES[1]))
    round_ = Round(1, 100, 600, 2, kills, alive_states=(state,))

    assert windows(score(round_, types=("clutch",))) == [(1, 190, 235), (1, 360, 405)]


@pytest.mark.parametrize(
    ("second_tick", "expected"),
    [(184, [(1, 100, 199)]), (185, [(1, 100, 135), (1, 155, 200)])],
)
def test_merge_gap_is_strictly_less_than_configured_limit(second_tick, expected):
    kills = (enemy_kill(120, ENEMIES[0], "knife"), enemy_kill(second_tick, ENEMIES[1], "knife"))
    round_ = Round(1, 100, 200, 2, kills)

    assert windows(score(round_, types=("knife",))) == expected


def test_windows_and_victim_povs_are_clamped_to_their_round():
    round_1 = Round(1, 100, 200, 2, (enemy_kill(198, ENEMIES[0], "knife"),))
    round_2 = Round(2, 201, 300, 2, (enemy_kill(203, ENEMIES[0], "knife"),))

    clips = score(round_1, round_2, types=("knife",), victim_pov=True)

    assert windows(clips) == [(1, 168, 200), (2, 201, 218)]
    assert [(p["start_tick"], p["end_tick"]) for c in clips for p in c["victim_povs"]] == [
        (178, 200),
        (201, 208),
    ]


def test_round_ending_kill_can_include_post_roll_before_next_round():
    kills = (enemy_kill(200, ENEMIES[0], "knife"), enemy_kill(201, ENEMIES[1], "knife"))
    round_ = Round(1, 100, 200, 2, kills, clip_end_tick=212)

    clips = score(round_, types=("knife",), victim_pov=True)

    assert windows(clips) == [(1, 170, 212)]
    assert [(pov["death_tick"], pov["end_tick"]) for pov in clips[0]["victim_povs"]] == [
        (200, 205),
    ]


def test_task_rules_can_change_thresholds_window_lengths_and_special_labels():
    kills = (enemy_kill(200, ENEMIES[0], "knife"), enemy_kill(240, ENEMIES[1], "taser"))
    round_ = Round(1, 100, 600, 2, kills)
    rules = parse_rules(
        {
            "quick_kills_window_s": 4,
            "pre_s": 1,
            "post_s": 2,
            "victim_pre_s": 0.5,
            "victim_post_s": 1,
            "knife_as_special": False,
            "zeus_as_special": False,
        }
    )

    clips = score(round_, types=("quick_kills",), rules=rules, victim_pov=True)

    assert windows(clips) == [(1, 190, 260)]
    assert "special" not in clips[0]["types"]
    assert [pov["duration_s"] for pov in clips[0]["victim_povs"]] == [1.5, 1.5]


@pytest.mark.parametrize(
    "invalid",
    [[], {"pre_s": True}, {"pre_s": -0.1}, {"post_s": float("inf")}, {"unknown": 1}],
)
def test_invalid_rule_values_are_rejected(invalid):
    with pytest.raises(ValueError):
        parse_rules(invalid)
