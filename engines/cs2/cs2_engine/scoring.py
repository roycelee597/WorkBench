from bisect import bisect_left, bisect_right
from collections import defaultdict
from collections.abc import Collection, Iterable, Iterator
from dataclasses import dataclass
from decimal import Decimal
from math import ceil, floor, isfinite
from typing import TypedDict

from .models import Demo, Kill, Round
from .rules import Rules, weapon_name

_OPPONENT_TEAM = {2: 3, 3: 2}


class VictimPreview(TypedDict):
    steamid64: str | None
    death_tick: int
    start_tick: int
    end_tick: int
    duration_s: float


class HighlightPreview(TypedDict):
    round: int
    types: list[str]
    tags: list[str]
    start_tick: int
    end_tick: int
    duration_s: float
    victim_povs: list[VictimPreview]


@dataclass(frozen=True, slots=True)
class _Candidate:
    kind: str
    tags: tuple[str, ...]
    start_tick: int
    end_tick: int
    kill_indices: range


def _tick_distance(seconds: float, rate: float) -> Decimal:
    # 保留 JSON 小数的边界含义，例如 0.29 秒乘 100 tick 恰好是 29 tick。
    return Decimal(str(seconds)) * Decimal(str(rate))


def _clip_end(round_: Round) -> int:
    # 回合结束动画仍可用于击杀后的画面，只有逻辑回合内的事件参与评分。
    return round_.end_tick if round_.clip_end_tick is None else round_.clip_end_tick


def _enemy_kills(round_: Round, player_id: str) -> list[Kill]:
    kills = []
    seen: set[tuple[int, str]] = set()
    for kill in sorted(round_.kills, key=lambda item: item.tick):
        if (
            kill.attacker_id != player_id
            or kill.victim_id == player_id
            or kill.attacker_team not in _OPPONENT_TEAM
            or kill.victim_team not in _OPPONENT_TEAM
            or kill.attacker_team == kill.victim_team
            or not round_.start_tick <= kill.tick <= round_.end_tick
        ):
            continue
        if kill.victim_id is not None:
            key = (kill.tick, kill.victim_id)
            if key in seen:
                continue
            seen.add(key)
        kills.append(kill)
    return kills


def _clutch_start(round_: Round, player_id: str, rules: Rules) -> tuple[int, int] | None:
    if round_.winner_team not in _OPPONENT_TEAM:
        return None
    previous_team = None
    for state in sorted(round_.alive_states, key=lambda item: item.tick):
        if not round_.start_tick <= state.tick <= round_.end_tick:
            continue
        lone_team = next(
            (team for team in _OPPONENT_TEAM if state.players_by_team.get(team) == {player_id}),
            None,
        )
        became_lone = lone_team != previous_team
        previous_team = lone_team
        if not became_lone or lone_team is None:
            continue
        if lone_team != round_.winner_team and not rules.clutch_include_losses:
            continue
        opponent_count = len(state.players_by_team.get(_OPPONENT_TEAM[lone_team], ()))
        if opponent_count >= rules.clutch_min_enemies:
            return state.tick, opponent_count
    return None


def _single_kill_tags(
    kill: Kill, rules: Rules, shots: dict[str, list[int]], onetap_ticks: int
) -> Iterator[tuple[str, tuple[str, ...]]]:
    weapon = weapon_name(kill.weapon)
    knife = weapon in rules.knife_weapons or weapon.startswith(rules.knife_weapon_prefixes)
    zeus = weapon in rules.zeus_weapons
    conditions = {
        "wallbang": kill.penetrated >= rules.special_min_penetrations,
        "airborne": kill.attacker_in_air,
        "blind": kill.attacker_blind,
        "through_smoke": kill.through_smoke,
    }
    special = [tag for tag in rules.special_conditions if conditions[tag]]
    if knife:
        yield "knife", ("knife",)
        if rules.knife_as_special:
            special.append("knife")
    if zeus:
        yield "zeus", ("zeus",)
        if rules.zeus_as_special:
            special.append("zeus")
    if special:
        yield "special", tuple(special)
    if kill.noscope and weapon in rules.noscope_weapons:
        yield "noscope", ("noscope",)
    if kill.headshot and weapon in rules.onetap_weapons:
        fire_ticks = shots.get(weapon, [])
        first = bisect_left(fire_ticks, kill.tick - onetap_ticks)
        after_last = bisect_right(fire_ticks, kill.tick)
        if after_last - first == 1:
            yield "onetap", ("onetap",)


def _candidates(
    round_: Round, kills: list[Kill], player_id: str, rules: Rules, rate: float
) -> Iterator[_Candidate]:
    kill_ticks = [kill.tick for kill in kills]
    pre = ceil(_tick_distance(rules.pre_s, rate))
    post = ceil(_tick_distance(rules.post_s, rate))
    quick_window = floor(_tick_distance(rules.quick_kills_window_s, rate))
    onetap_window = floor(_tick_distance(rules.onetap_window_s, rate))

    def kill_window(kind: str, tags: tuple[str, ...], indices: range) -> _Candidate:
        return _Candidate(
            kind,
            tags,
            max(round_.start_tick, kill_ticks[indices.start] - pre),
            min(_clip_end(round_), kill_ticks[indices.stop - 1] + post),
            indices,
        )

    if len(kills) >= rules.multikill_min_kills:
        tag = "ACE" if len(kills) >= rules.ace_min_kills else f"{len(kills)}K"
        yield kill_window("multikill", (tag,), range(len(kills)))

    clutch = _clutch_start(round_, player_id, rules)
    if clutch is not None:
        start_tick, opponent_count = clutch
        tags = (f"1v{opponent_count}",)
        first = bisect_left(kill_ticks, start_tick)
        if round_.end_tick - start_tick <= _tick_distance(rules.clutch_max_s, rate):
            yield _Candidate("clutch", tags, start_tick, round_.end_tick, range(first, len(kills)))
        else:
            for index in range(first, len(kills)):
                yield kill_window("clutch", tags, range(index, index + 1))

    shots: dict[str, list[int]] = defaultdict(list)
    for shot in sorted(round_.shots, key=lambda item: item.tick):
        if shot.player_id == player_id and round_.start_tick <= shot.tick <= round_.end_tick:
            shots[weapon_name(shot.weapon)].append(shot.tick)

    for first, kill in enumerate(kills):
        after_last = bisect_right(kill_ticks, kill.tick + quick_window, lo=first)
        if after_last - first >= rules.quick_kills_min_kills:
            yield kill_window("quick_kills", ("quick_kills",), range(first, after_last))
        for kind, tags in _single_kill_tags(kill, rules, shots, onetap_window):
            yield kill_window(kind, tags, range(first, first + 1))


def _victim_previews(
    round_: Round, kills: list[Kill], indices: set[int], rules: Rules, rate: float
) -> list[VictimPreview]:
    pre = ceil(_tick_distance(rules.victim_pre_s, rate))
    post = ceil(_tick_distance(rules.victim_post_s, rate))
    previews: list[VictimPreview] = []
    for index in sorted(indices):
        kill = kills[index]
        start = max(round_.start_tick, kill.tick - pre)
        end = min(_clip_end(round_), kill.tick + post)
        victim_id = kill.victim_id
        if victim_id is not None and victim_id.startswith("bot:"):
            victim_id = None
        previews.append(
            {
                "steamid64": victim_id,
                "death_tick": kill.tick,
                "start_tick": start,
                "end_tick": end,
                "duration_s": (end - start) / rate,
            }
        )
    return previews


def _merge_candidates(
    candidates: Iterable[_Candidate], merge_gap: int
) -> Iterator[list[_Candidate]]:
    clip: list[_Candidate] = []
    end_tick = 0
    for candidate in candidates:
        gap = candidate.start_tick - end_tick
        if clip and gap > 0 and gap >= merge_gap:
            yield clip
            clip = []
        clip.append(candidate)
        end_tick = max(end_tick, candidate.end_tick)
    if clip:
        yield clip


def _score_round(
    round_: Round,
    player_id: str,
    highlights: Collection[str],
    rules: Rules,
    rate: float,
    victim_pov: bool,
) -> Iterator[HighlightPreview]:
    kills = _enemy_kills(round_, player_id)
    candidates = sorted(
        _candidates(round_, kills, player_id, rules, rate), key=lambda item: item.start_tick
    )
    matching_types: dict[int, set[str]] = defaultdict(set)
    matching_tags: dict[int, set[str]] = defaultdict(set)
    for candidate in candidates:
        for index in candidate.kill_indices:
            matching_types[index].add(candidate.kind)
            matching_tags[index].update(candidate.tags)

    selected = (candidate for candidate in candidates if candidate.kind in highlights)
    merge_gap = ceil(_tick_distance(rules.merge_gap_s, rate))
    for clip in _merge_candidates(selected, merge_gap):
        types = {item.kind for item in clip}
        tags = {tag for item in clip for tag in item.tags}
        indices = {index for item in clip for index in item.kill_indices}
        # 未勾选的类型仍可描述片段里的击杀，但不会拉长片段。
        for index in indices:
            types.update(matching_types[index])
            tags.update(matching_tags[index])
        start_tick = clip[0].start_tick
        end_tick = max(item.end_tick for item in clip)
        victim_povs = _victim_previews(round_, kills, indices, rules, rate) if victim_pov else []
        yield {
            "round": round_.number,
            "types": sorted(types),
            "tags": sorted(tags),
            "start_tick": start_tick,
            "end_tick": end_tick,
            "duration_s": (end_tick - start_tick) / rate,
            "victim_povs": victim_povs,
        }


def score_demo(
    demo: Demo,
    player_id: str,
    highlights: Collection[str],
    rules: Rules,
    *,
    victim_pov: bool = False,
) -> list[HighlightPreview]:
    if not isfinite(demo.tick_rate) or demo.tick_rate <= 0:
        raise ValueError("demo 的 tick 频率必须大于零")
    if not highlights:
        return []

    previews: list[HighlightPreview] = []
    for round_ in sorted(demo.rounds, key=lambda item: (item.start_tick, item.number)):
        round_previews = _score_round(
            round_, player_id, highlights, rules, demo.tick_rate, victim_pov
        )
        previews.extend(round_previews)
    return previews
