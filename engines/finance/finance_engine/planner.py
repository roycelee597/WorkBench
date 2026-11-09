"""纯函数规划：市场自然日历、就绪时间、最近三日修正与断点续传。"""

from collections.abc import Set
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

SHANGHAI = timezone(timedelta(hours=8))
STOCK_START = 20150101
VALUATION_START = 20050101


def day_number(now: datetime) -> int:
    return int(now.astimezone(SHANGHAI).strftime("%Y%m%d"))


def ready_days(days: list[int], now: datetime, hour: int, start: int) -> list[int]:
    local = now.astimezone(SHANGHAI)
    today = day_number(local)
    return [day for day in days if start <= day <= today and (day < today or local.hour >= hour)]


@dataclass(frozen=True)
class Plan:
    recent: list[int]
    backfill: list[int]


def plan_stock(
    days: list[int],
    states: dict[tuple[str, int], str],
    now: datetime,
    *,
    exhausted_factors: Set[int] = frozenset(),
) -> Plan:
    eligible = ready_days(days, now, 16, STOCK_START)
    refreshed = set(eligible[-3:])
    missing = [
        day
        for day in eligible
        if day in refreshed
        or states.get(("stock_daily", day)) != "ok"
        or (day not in exhausted_factors and states.get(("adj_factor", day)) != "ok")
    ]
    recent = set(eligible[-65:])
    return Plan(
        [day for day in missing if day in recent], [day for day in missing if day not in recent]
    )
