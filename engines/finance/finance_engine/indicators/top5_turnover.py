"""前 5% 沪深 A 股成交额占比。"""

import math

from .base import ComputeContext, SeriesPoint


def top5_turnover(day: int, rows: list[dict]) -> SeriesPoint:
    pool = sorted(
        (row for row in rows if row["ts_code"].endswith((".SH", ".SZ")) and row["amount"] > 0),
        key=lambda row: (-row["amount"], row["ts_code"]),
    )
    n = len(pool)
    k = math.ceil(n * 0.05)
    total = math.fsum(row["amount"] for row in pool)
    value = math.fsum(row["amount"] for row in pool[:k]) / total * 100 if total else None
    return SeriesPoint("top5_turnover_share", day, value, {"n": n, "k": k})


class Top5Turnover:
    id = "top5_turnover_share"
    depends_on = ["stock_daily"]
    lookback_days = 0

    def meta(self) -> dict:
        return {
            "id": self.id,
            "name": "前5%个股成交额占比",
            "group": "交易拥挤",
            "order": 10,
            "unit": "percent",
            "decimals": 1,
            "series": [{"key": self.id, "label": "日值", "primary": True}],
            "views": {"monthly_avg": True, "default": "daily", "overlay_hs300": True},
            "default_thresholds": [
                {
                    "default_key": "top5_gt_45",
                    "series_key": self.id,
                    "direction": "above",
                    "level": 45,
                    "hysteresis": 1,
                    "label": "交易拥挤",
                }
            ],
            "description_md": "**口径**：沪深 A 股非停牌个股，取成交额前 ceil(N×5%) 的占比。"
            "不含北交所，包含 ST；阈值按日值判断。\n"
            "**解读**：高于 45% 表示交易较拥挤，注意风险。",
        }

    def compute(self, ctx: ComputeContext, dates: list[int]) -> list[SeriesPoint]:
        return [
            top5_turnover(
                day,
                [
                    dict(row)
                    for row in ctx.connection.execute(
                        "SELECT s.ts_code,d.amount FROM stock_daily d JOIN securities s USING(sid) "
                        "WHERE trade_date=?",
                        (day,),
                    )
                ],
            )
            for day in dates
        ]
