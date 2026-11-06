"""只累计截至当天的数据；自然年窗口，平值按小于等于计数。"""

import bisect
import calendar
import math
from collections import deque
from datetime import date

from .base import ComputeContext, SeriesPoint

INDICES = {"000300.SH": "沪深300", "399006.SZ": "创业板指", "000001.SH": "上证指数"}


def parse_day(day: int) -> date:
    return date(day // 10000, day // 100 % 100, day % 100)


def months_before(day: date, months: int) -> date:
    absolute = day.year * 12 + day.month - 1 - months
    year, month = absolute // 12, absolute % 12 + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def valuation_points(
    code: str, rows: list[dict], dates: set[int] | None = None
) -> list[SeriesPoint]:
    points = []
    for metric in ("pe_ttm", "pb"):
        values = {window: [] for window in ("5y", "10y", "all")}
        queues = {window: deque() for window in values}
        first = None
        for row in sorted(rows, key=lambda item: item["trade_date"]):
            number = row.get(metric)
            value = float(number) if number is not None else None
            if value is not None and (
                not math.isfinite(value) or (metric == "pe_ttm" and value <= 0)
            ):
                value = None
            day = int(row["trade_date"])
            current = parse_day(day)
            if value is not None and first is None:
                first = current
            prefix = f"valuation.{code}.{metric}"
            if dates is None or day in dates:
                points.append(SeriesPoint(prefix + ".raw", day, value))
            for window, months, minimum in (("5y", 60, 54), ("10y", 120, 108), ("all", 0, 36)):
                ordered, queue = values[window], queues[window]
                cutoff = months_before(current, months) if months else date.min
                while queue and queue[0][0] < cutoff:
                    _, old = queue.popleft()
                    ordered.pop(bisect.bisect_left(ordered, old))
                if value is not None:
                    bisect.insort(ordered, value)
                    queue.append((current, value))
                sufficient = bool(queue) and queue[0][0] <= months_before(current, minimum)
                percentile = (
                    bisect.bisect_right(ordered, value) / len(ordered) * 100
                    if value is not None and sufficient
                    else None
                )
                if dates is None or day in dates:
                    points.append(
                        SeriesPoint(
                            prefix + ".pct_" + window, day, percentile, {"samples": len(ordered)}
                        )
                    )
    return points


class IndexValuation:
    id = "index_valuation"
    depends_on = ["index_valuation"]
    lookback_days = 0

    def meta(self) -> dict:
        series, thresholds = [], []
        for code, name in INDICES.items():
            for metric in ("pe_ttm", "pb"):
                for window in ("raw", "pct_5y", "pct_10y", "pct_all"):
                    series.append(
                        {
                            "key": f"valuation.{code}.{metric}.{window}",
                            "index": code,
                            "metric": metric,
                            "window": window,
                            "label": name,
                        }
                    )
            for direction, level, label in (("below", 20, "估值便宜"), ("above", 80, "估值偏贵")):
                thresholds.append(
                    {
                        "default_key": f"valuation_{code}_{direction}_{level}",
                        "series_key": f"valuation.{code}.pe_ttm.pct_10y",
                        "direction": direction,
                        "level": level,
                        "hysteresis": 5,
                        "label": name + label,
                    }
                )
        return {
            "id": self.id,
            "name": "主要指数估值分位",
            "group": "估值",
            "order": 30,
            "unit": "percent",
            "decimals": 1,
            "series": series,
            "dimensions": {
                "indices": [{"value": key, "label": value} for key, value in INDICES.items()],
                "metrics": ["pe_ttm", "pb"],
                "windows": ["5y", "10y", "all"],
                "default_metric": "pe_ttm",
                "default_window": "10y",
                "default_view": "percentile",
                "views": ["percentile", "raw"],
            },
            "views": {"overlay_hs300": True},
            "default_thresholds": thresholds,
            "description_md": "**口径**：截至当日，窗口中小于等于当日估值的有效天数占比。"
            "5 年/10 年/全部至少有 4.5 年/9 年/3 年历史；不使用未来数据。\n"
            "**解读**：PE-TTM 十年分位低于 20% 提示便宜，高于 80% 提示偏贵。",
        }

    def compute(self, ctx: ComputeContext, dates: list[int]) -> list[SeriesPoint]:
        return [
            point
            for code in INDICES
            for point in valuation_points(
                code,
                [
                    dict(row)
                    for row in ctx.connection.execute(
                        "SELECT * FROM index_valuation WHERE ts_code=? ORDER BY trade_date", (code,)
                    )
                ],
                set(dates),
            )
        ]
