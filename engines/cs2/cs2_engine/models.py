from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Player:
    steamid64: str
    name: str


@dataclass(frozen=True, slots=True)
class Kill:
    tick: int
    attacker_id: str | None
    victim_id: str | None
    attacker_team: int | None
    victim_team: int | None
    weapon: str
    headshot: bool = False
    penetrated: int = 0
    attacker_in_air: bool = False
    attacker_blind: bool = False
    through_smoke: bool = False
    noscope: bool = False


@dataclass(frozen=True, slots=True)
class Shot:
    tick: int
    player_id: str
    weapon: str


@dataclass(frozen=True, slots=True)
class AliveState:
    tick: int
    players_by_team: dict[int, frozenset[str]]


@dataclass(frozen=True, slots=True)
class Round:
    number: int
    start_tick: int
    end_tick: int
    winner_team: int | None
    kills: tuple[Kill, ...] = ()
    shots: tuple[Shot, ...] = ()
    alive_states: tuple[AliveState, ...] = ()
    clip_end_tick: int | None = None


@dataclass(frozen=True, slots=True)
class Demo:
    tick_rate: float
    players: tuple[Player, ...]
    rounds: tuple[Round, ...]
