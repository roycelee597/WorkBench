from __future__ import annotations

from pathlib import Path

import demoparser2
import pytest

from cs2_engine.models import AliveState, Demo, Kill, Player, Round, Shot
from cs2_engine.parser import DemoParseError, _weapon, parse_demo

_PLAYER = 10_000_000_000_000_001
_OPPONENT = 10_000_000_000_000_009


class _Frame:
    def __init__(self, *rows: dict[str, object]) -> None:
        self.rows = rows

    def to_dict(self, orient: str) -> list[dict[str, object]]:
        assert orient == "records"
        return list(self.rows)


def _snapshot(tick: int, steamid: int, team: int, **fields: object) -> dict[str, object]:
    return {
        "tick": tick,
        "steamid": steamid,
        "team_num": team,
        "is_alive": True,
        "name": "玩家" if steamid == _PLAYER else "对手",
        **fields,
    }


def _death(tick: int, **fields: object) -> dict[str, object]:
    return {
        "tick": tick,
        "attacker_steamid": str(_PLAYER),
        "attacker_team_num": 3,
        "user_steamid": "0",
        "user_entity_id": 21,
        "user_team_num": 2,
        "weapon": "custom_pack_deagle",
        "headshot": True,
        "attackerblind": True,
        "penetrated": 1,
        **fields,
    }


class _SyntheticParser:
    def __init__(self, path: str) -> None:
        assert Path(path).name == "demo.dem"

    def parse_events(
        self, names: list[str], *, player: list[str], other: list[str]
    ) -> list[tuple[str, _Frame]]:
        assert {
            "round_start",
            "round_freeze_end",
            "round_end",
            "weapon_fire",
            "player_death",
        } <= set(names)
        assert player == ["team_num", "entity_id"]
        assert other == ["is_warmup_period", "total_rounds_played"]
        return [
            (
                "round_start",
                _Frame(
                    {"tick": 3, "round": 1, "is_warmup_period": True},
                    {"tick": 100, "round": 1},
                    {"tick": 250, "round": 2},
                ),
            ),
            ("round_freeze_end", _Frame({"tick": 120}, {"tick": 270})),
            (
                "round_end",
                _Frame({"tick": 8, "is_warmup_period": True}, {"tick": 180, "winner": "CT"}),
            ),
            ("cs_win_panel_match", _Frame({"tick": 350})),
            ("player_death", _Frame(_death(5, is_warmup_period=True), _death(110), _death(180))),
            (
                "weapon_fire",
                _Frame({"tick": 180, "user_steamid": str(_PLAYER), "weapon": "weapon_deagle"}),
            ),
        ]

    def parse_ticks(self, props: list[str], *, ticks: list[int]) -> _Frame:
        assert {"team_num", "is_alive", "entity_id", "is_connected"} == set(props)
        assert ticks == [110, 120, 180, 270]
        return _Frame(
            _snapshot(120, _PLAYER, 3, name="旧名称"),
            _snapshot(120, 0, 2, entity_id=21),
            _snapshot(120, _OPPONENT, 2),
            _snapshot(180, _PLAYER, 3),
            _snapshot(180, 0, 2, entity_id=21, is_alive=False),
            _snapshot(180, _OPPONENT, 2, is_connected=8),
        )

    def parse_player_info(self) -> _Frame:
        return _Frame(
            {"steamid": _PLAYER, "name": "玩家", "team_number": 3},
            {"steamid": 0, "name": "机器人", "team_number": 2},
            {"steamid": float(_PLAYER), "name": "精度损失", "team_number": 2},
            {"steamid": 100, "name": "旁观者", "team_number": 1},
        )


def test_parse_demo_reconstructs_playable_rounds_with_synthetic_events(tmp_path, monkeypatch):
    demo = tmp_path / "demo.dem"
    demo.write_bytes(b"PBDEMS2\x00" + bytes(8))
    monkeypatch.setattr(demoparser2, "DemoParser", _SyntheticParser)

    assert parse_demo(demo) == Demo(
        tick_rate=64.0,
        players=(Player(str(_OPPONENT), "对手"), Player(str(_PLAYER), "玩家")),
        rounds=(
            Round(
                number=1,
                start_tick=100,
                end_tick=180,
                winner_team=3,
                kills=(
                    Kill(
                        180,
                        str(_PLAYER),
                        "bot:21",
                        3,
                        2,
                        "deagle",
                        headshot=True,
                        penetrated=1,
                        attacker_blind=True,
                    ),
                ),
                shots=(Shot(180, str(_PLAYER), "deagle"),),
                alive_states=(
                    AliveState(
                        120,
                        {2: frozenset({"bot:21", str(_OPPONENT)}), 3: frozenset({str(_PLAYER)})},
                    ),
                    AliveState(180, {2: frozenset(), 3: frozenset({str(_PLAYER)})}),
                ),
                clip_end_tick=249,
            ),
            Round(2, 250, 350, None, clip_end_tick=350),
        ),
    )


def test_parse_demo_rejects_invalid_or_missing_input_without_exposing_path(tmp_path):
    demo = tmp_path / "个人录像.dem"
    with pytest.raises(DemoParseError, match="^无法读取录像文件。$"):
        parse_demo(demo)
    demo.write_bytes(b"HL2DEMO\x00" + bytes(8))
    with pytest.raises(DemoParseError, match="^文件不是有效的 CS2 录像。$"):
        parse_demo(demo)


@pytest.mark.parametrize(
    "event_weapon, rule_weapon",
    [("weapon_knife_karambit", "knife_karambit"), ("knife_m9_bayonet", "knife_m9_bayonet")],
)
def test_weapon_normalization_preserves_knife_variants(event_weapon, rule_weapon):
    assert _weapon(event_weapon) == rule_weapon
