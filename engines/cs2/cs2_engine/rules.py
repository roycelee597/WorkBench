from dataclasses import dataclass, fields
from math import isfinite

HIGHLIGHT_TYPES = (
    "multikill",
    "clutch",
    "quick_kills",
    "special",
    "knife",
    "zeus",
    "noscope",
    "onetap",
)
SPECIAL_CONDITIONS = ("wallbang", "airborne", "blind", "through_smoke")


@dataclass(frozen=True, slots=True)
class Rules:
    multikill_min_kills: int = 3
    ace_min_kills: int = 5
    clutch_min_enemies: int = 2
    clutch_include_losses: bool = False
    clutch_max_s: float = 30.0
    quick_kills_min_kills: int = 2
    quick_kills_window_s: float = 3.0
    special_conditions: tuple[str, ...] = SPECIAL_CONDITIONS
    special_min_penetrations: int = 1
    knife_as_special: bool = True
    zeus_as_special: bool = True
    knife_weapons: tuple[str, ...] = ("knife", "knifegg", "bayonet")
    knife_weapon_prefixes: tuple[str, ...] = ("knife_",)
    zeus_weapons: tuple[str, ...] = ("taser",)
    noscope_weapons: tuple[str, ...] = ("awp", "ssg08")
    onetap_weapons: tuple[str, ...] = ("ak47", "deagle")
    onetap_window_s: float = 1.0
    pre_s: float = 3.0
    post_s: float = 1.5
    merge_gap_s: float = 2.0
    victim_pre_s: float = 2.0
    victim_post_s: float = 0.5


def weapon_name(value: str) -> str:
    return value.strip().lower().removeprefix("weapon_")


def _seconds(value: object, name: str) -> float:
    if type(value) not in (int, float):
        raise ValueError(f"规则 {name} 必须是非负秒数")
    try:
        seconds = float(value)
    except OverflowError:
        raise ValueError(f"规则 {name} 必须是有限秒数") from None
    if not isfinite(seconds) or seconds < 0:
        raise ValueError(f"规则 {name} 必须是有限的非负秒数")
    return seconds


def _names(value: object, name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"规则 {name} 必须是字符串数组")
    if name == "special_conditions":
        if any(item not in SPECIAL_CONDITIONS for item in value):
            raise ValueError("规则 special_conditions 含有未知的特殊击杀条件")
        return tuple(dict.fromkeys(value))
    normalized = tuple(dict.fromkeys(weapon_name(item) for item in value))
    if "" in normalized:
        raise ValueError(f"规则 {name} 含有空白武器名")
    return normalized


def parse_rules(value: object) -> Rules:
    if not isinstance(value, dict):
        raise ValueError("rules 必须是 JSON 对象")

    defaults = Rules()
    known_fields = {field.name for field in fields(Rules)}
    if value.keys() - known_fields:
        raise ValueError("rules 含有未知的规则项")

    overrides = {}
    for name, item in value.items():
        default = getattr(defaults, name)
        if isinstance(default, bool):
            if type(item) is not bool:
                raise ValueError(f"规则 {name} 必须是布尔值")
            overrides[name] = item
        elif isinstance(default, int):
            minimum = 2 if name.endswith("min_kills") else 1
            if type(item) is not int or item < minimum:
                raise ValueError(f"规则 {name} 必须是大于等于 {minimum} 的整数")
            overrides[name] = item
        elif isinstance(default, float):
            overrides[name] = _seconds(item, name)
        else:
            overrides[name] = _names(item, name)
    return Rules(**overrides)
