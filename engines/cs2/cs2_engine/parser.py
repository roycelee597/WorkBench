from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .models import AliveState, Demo, Kill, Player, Round, Shot

_CS2_HEADER = b"PBDEMS2\x00"
_TICK_RATE = 64.0
_TEAMS = {"T": 2, "TERRORIST": 2, "CT": 3}
_TEAM_NUMBERS = frozenset(_TEAMS.values())
_WEAPON_RULE_NAMES = frozenset({"ak47", "awp", "deagle", "ssg08", "taser"})
_KNIFE_NAMES = frozenset({"knife", "knifegg", "bayonet"})
_ALIVE_CHANGE_EVENTS = (
    "player_death",
    "player_disconnect",
    "player_spawn",
    "player_team",
    "bot_takeover",
)
_EVENTS = (
    "round_start",
    "round_freeze_end",
    "round_end",
    "round_officially_ended",
    "cs_win_panel_match",
    "weapon_fire",
    *_ALIVE_CHANGE_EVENTS,
)

type _Row = dict[str, object]


class DemoParseError(ValueError):
    """录像无法读出有效的 CS2 对局数据。"""


@dataclass(frozen=True, slots=True)
class _RoundBounds:
    number: int
    start: int
    live: int
    end: int
    clip_end: int
    winner: int | None


def _integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) or isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _tick(row: _Row) -> int | None:
    value = _integer(row.get("tick"))
    return value if value is not None and value >= 0 else None


def _team(value: object) -> int | None:
    if isinstance(value, str):
        return _TEAMS.get(value.upper())
    number = _integer(value)
    return number if number in _TEAM_NUMBERS else None


def _steam_id(value: object) -> str | None:
    # 击杀事件使用字符串，玩家列表和 tick 表使用 uint64。禁止经浮点数转换身份。
    if isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 20:
        value = int(value)
    if type(value) is int and 0 < value < 1 << 64:
        return str(value)
    return None


def _actor(steamid: object, entity: object) -> str | None:
    steamid64 = _steam_id(steamid)
    if steamid64 is not None:
        return steamid64
    entity_id = _integer(entity)
    return f"bot:{entity_id}" if entity_id is not None and entity_id > 0 else None


def _weapon(value: object) -> str:
    if not isinstance(value, str):
        return ""
    name = value.strip().lower().removeprefix("weapon_")
    if name in _KNIFE_NAMES or name.startswith("knife_"):
        return name
    # 平台皮肤可能在击杀事件中给武器名添加前缀或后缀，开火事件仍使用标准名。
    parts = name.split("_")
    return next(
        (part for part in parts if part in _WEAPON_RULE_NAMES or part in _KNIFE_NAMES), name
    )


def _match_rows(rows: list[_Row]) -> dict[int, _Row]:
    return {
        tick: row
        for row in rows
        if row.get("is_warmup_period") is not True and (tick := _tick(row)) is not None
    }


def _round_bounds(events: dict[str, list[_Row]]) -> list[_RoundBounds]:
    starts = _match_rows(events.get("round_start", []))
    freezetime_ends = _match_rows(events.get("round_freeze_end", []))
    ends = _match_rows(events.get("round_end", []))
    starts = starts or freezetime_ends
    start_ticks = sorted(starts)
    freeze_ticks = sorted(freezetime_ends)
    end_ticks = sorted(ends)
    last_event_tick = max((_tick(row) or 0 for rows in events.values() for row in rows), default=0)

    rounds = []
    for index, start in enumerate(start_ticks):
        clip_end = start_ticks[index + 1] - 1 if index + 1 < len(starts) else last_event_tick
        freeze_index = bisect_left(freeze_ticks, start)
        live = start
        if freeze_index < len(freeze_ticks) and freeze_ticks[freeze_index] <= clip_end:
            live = freeze_ticks[freeze_index]
        end_index = bisect_left(end_ticks, live)
        end = clip_end
        winner = None
        if end_index < len(end_ticks) and end_ticks[end_index] <= clip_end:
            end = end_ticks[end_index]
            winner = _team(ends[end].get("winner"))
        number = _integer(starts[start].get("round"))
        if number is None:
            previous_rounds = _integer(starts[start].get("total_rounds_played"))
            number = previous_rounds + 1 if previous_rounds is not None else index + 1
        if number > 0 and end > live:
            rounds.append(_RoundBounds(number, start, live, end, clip_end, winner))
    return rounds


def _kill(row: _Row, tick: int) -> Kill:
    return Kill(
        tick=tick,
        attacker_id=_actor(row.get("attacker_steamid"), row.get("attacker_entity_id")),
        victim_id=_actor(row.get("user_steamid"), row.get("user_entity_id")),
        attacker_team=_team(row.get("attacker_team_num")),
        victim_team=_team(row.get("user_team_num")),
        weapon=_weapon(row.get("weapon")),
        headshot=row.get("headshot") is True,
        penetrated=_integer(row.get("penetrated")) or 0,
        attacker_in_air=row.get("attackerinair") is True,
        attacker_blind=row.get("attackerblind") is True,
        through_smoke=row.get("thrusmoke") is True,
        noscope=row.get("noscope") is True,
    )


def _shot(row: _Row, tick: int) -> Shot | None:
    player = _steam_id(row.get("user_steamid"))
    weapon = _weapon(row.get("weapon"))
    return Shot(tick, player, weapon) if player and weapon else None


def _alive_states(rows: list[_Row], deaths_by_tick: dict[int, list[Kill]]) -> dict[int, AliveState]:
    teams_by_tick: defaultdict[int, dict[int, set[str]]] = defaultdict(lambda: {2: set(), 3: set()})
    for row in rows:
        tick = _tick(row)
        if tick is None:
            continue
        teams = teams_by_tick[tick]
        side = _team(row.get("team_num"))
        player = _actor(row.get("steamid"), row.get("entity_id"))
        connected = _integer(row.get("is_connected")) in (0, None)
        if row.get("is_alive") is True and connected and side is not None and player:
            teams[side].add(player)

    # 死亡事件可能先于存活属性更新。用事件校正该 tick 的阵容，保留实际死亡时间。
    for tick, deaths in deaths_by_tick.items():
        teams = teams_by_tick.get(tick)
        if teams is None:
            continue
        dead_players = {death.victim_id for death in deaths if death.victim_id is not None}
        for players in teams.values():
            players.difference_update(dead_players)

    return {
        tick: AliveState(tick, {side: frozenset(players) for side, players in teams.items()})
        for tick, teams in teams_by_tick.items()
    }


def _players(info_rows: list[_Row], tick_rows: list[_Row]) -> tuple[Player, ...]:
    names: dict[str, str] = {}
    # 最终玩家信息优先，tick 数据补全中途退出、改名或切换队伍的参赛者。
    for rows, team_key in ((tick_rows, "team_num"), (info_rows, "team_number")):
        for row in rows:
            steamid = _steam_id(row.get("steamid"))
            name = row.get("name")
            if steamid and isinstance(name, str) and _team(row.get(team_key)) is not None:
                names[steamid] = name
    return tuple(
        Player(steamid, name)
        for steamid, name in sorted(names.items(), key=lambda item: (item[1].casefold(), item[0]))
    )


def _make_rounds(
    bounds: list[_RoundBounds],
    events: dict[str, list[_Row]],
    tick_rows: list[_Row],
) -> tuple[Round, ...]:
    kills: dict[int, list[Kill]] = defaultdict(list)
    shots: dict[int, list[Shot]] = defaultdict(list)
    for row in events.get("player_death", []):
        if row.get("is_warmup_period") is not True and (tick := _tick(row)) is not None:
            kills[tick].append(_kill(row, tick))
    for row in events.get("weapon_fire", []):
        if row.get("is_warmup_period") is not True and (tick := _tick(row)) is not None:
            if (shot := _shot(row, tick)) is not None:
                shots[tick].append(shot)
    states = _alive_states(tick_rows, kills)
    kill_ticks = sorted(kills)
    shot_ticks = sorted(shots)
    state_ticks = sorted(states)
    return tuple(
        Round(
            number=span.number,
            start_tick=span.start,
            end_tick=span.end,
            winner_team=span.winner,
            kills=tuple(
                kill for tick in kill_ticks if span.live <= tick <= span.end for kill in kills[tick]
            ),
            shots=tuple(
                shot for tick in shot_ticks if span.live <= tick <= span.end for shot in shots[tick]
            ),
            alive_states=tuple(
                states[tick] for tick in state_ticks if span.live <= tick <= span.end
            ),
            clip_end_tick=span.clip_end,
        )
        for span in bounds
    )


def recorded_crosshairs(path: Path, targets: Iterable[tuple[str, int]]) -> set[tuple[str, int]]:
    """一次读取多个玩家和片段起点，返回有录像准星设置的玩家与 tick。"""
    requested = {(player, tick) for player, tick in targets if _steam_id(player) == player}
    if not requested:
        return set()

    try:
        from demoparser2 import DemoParser

        rows = (
            DemoParser(str(path))
            .parse_ticks(
                ["crosshair_code"],
                players=sorted({int(player) for player, _ in requested}),
                ticks=sorted({tick for _, tick in requested}),
            )
            .to_dict("records")
        )
    except BaseException as error:
        # 旧 demo 可能无法读取这个字段。解析失败只影响准星，用户取消仍向上传递。
        if not isinstance(error, Exception) and type(error).__module__ != "pyo3_runtime":
            raise
        return set()

    available = set()
    for row in rows:
        player_id = _steam_id(row.get("steamid"))
        tick = _tick(row)
        code = row.get("crosshair_code")
        if player_id is not None and tick is not None and isinstance(code, str) and code.strip():
            target = (player_id, tick)
            if target in requested:
                available.add(target)
    return available


def has_recorded_crosshair(path: Path, player_id: str, tick: int) -> bool:
    """检查目标玩家在片段起点是否有准星设置，由 CS2 回放负责读取样式。"""
    return bool(recorded_crosshairs(path, ((player_id, tick),)))


def parse_demo(path: Path) -> Demo:
    try:
        with path.open("rb") as source:
            header = source.read(16)
    except OSError:
        raise DemoParseError("无法读取录像文件。") from None
    if len(header) < 16 or not header.startswith(_CS2_HEADER):
        raise DemoParseError("文件不是有效的 CS2 录像。")

    try:
        from demoparser2 import DemoParser

        parser = DemoParser(str(path))
        raw_events = parser.parse_events(
            list(_EVENTS),
            player=["team_num", "entity_id"],
            other=["is_warmup_period", "total_rounds_played"],
        )
        events = {kind: frame.to_dict("records") for kind, frame in raw_events}
        bounds = _round_bounds(events)
        if not bounds:
            raise DemoParseError("录像中没有可分析的对局回合。")
        changes = {
            tick for kind in _ALIVE_CHANGE_EVENTS for tick in _match_rows(events.get(kind, []))
        }
        sample_ticks = set(changes)
        sample_ticks.update(span.live for span in bounds)
        tick_rows = parser.parse_ticks(
            ["team_num", "is_alive", "entity_id", "is_connected"],
            ticks=sorted(sample_ticks),
        ).to_dict("records")
        info_rows = parser.parse_player_info().to_dict("records")
    except DemoParseError:
        raise
    except BaseException as error:
        # PyO3 的 PanicException 继承 BaseException，另一类是用户主动中断，继续向上传递。
        if not isinstance(error, Exception) and type(error).__module__ != "pyo3_runtime":
            raise
        raise DemoParseError("解析 CS2 录像失败，文件可能损坏或版本不受支持。") from None

    return Demo(
        tick_rate=_TICK_RATE,
        players=_players(info_rows, tick_rows),
        rounds=_make_rounds(bounds, events, tick_rows),
    )
