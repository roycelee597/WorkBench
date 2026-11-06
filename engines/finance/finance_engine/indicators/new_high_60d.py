"""按市场交易日窗口计算后复权新高，不缩小缺因子时的分母。"""

import pandas as pd

from .base import ComputeContext, SeriesPoint


def new_high_points(
    rows: pd.DataFrame, securities: pd.DataFrame, calendar: list[int], dates: list[int]
) -> list[SeriesPoint]:
    if not calendar:
        return []
    if rows.empty or securities.empty:
        return [
            SeriesPoint("new_high_60d_share", day, None, {"status": "pending"}) for day in dates
        ]
    pool = securities[securities.ts_code.str.endswith((".SH", ".SZ"))].set_index("sid")
    trades = rows[(rows.amount > 0) & rows.sid.isin(pool.index)]
    close = trades.pivot(index="trade_date", columns="sid", values="close").reindex(calendar)
    factors = trades.pivot(index="trade_date", columns="sid", values="adj_factor").reindex(
        index=calendar, columns=close.columns
    )
    prices = close * factors
    counts = close.notna().rolling(60, min_periods=1).sum()
    highs = prices.rolling(60, min_periods=1).max()
    invalid = (close.notna() & (factors.isna() | (factors <= 0))).rolling(60, min_periods=1).sum()
    result = []
    positions = {day: index for index, day in enumerate(calendar)}
    for day in dates:
        position = positions[day]
        if position < 59:
            result.append(SeriesPoint("new_high_60d_share", day, None, {"status": "window_short"}))
            continue
        eligible = (
            close.loc[day].notna()
            & (counts.loc[day] >= 45)
            & (pool.list_date.reindex(close.columns) <= calendar[position - 59])
        )
        n = int(eligible.sum())
        if (invalid.loc[day][eligible] > 0).any():
            result.append(
                SeriesPoint(
                    "new_high_60d_share",
                    day,
                    None,
                    {"status": "pending", "reason": "adj_factor_missing", "n": n},
                )
            )
            continue
        count = int((prices.loc[day][eligible] >= highs.loc[day][eligible]).sum())
        result.append(
            SeriesPoint(
                "new_high_60d_share",
                day,
                count / n * 100 if n else None,
                {"n": n, "new_high": count, "status": "ok" if n else "empty"},
            )
        )
    return result


class NewHigh60d:
    id = "new_high_60d_share"
    depends_on = ["stock_daily", "adj_factor", "trade_calendar", "securities"]
    lookback_days = 59

    def meta(self) -> dict:
        return {
            "id": self.id,
            "name": "创60日新高个股占比",
            "group": "市场宽度",
            "order": 20,
            "unit": "percent",
            "decimals": 1,
            "series": [{"key": self.id, "label": "日值", "primary": True}],
            "views": {"overlay_hs300": True},
            "default_thresholds": [
                {
                    "default_key": "high60_gt_20",
                    "series_key": self.id,
                    "direction": "above",
                    "level": 20,
                    "hysteresis": 1,
                    "label": "普涨过热",
                },
                {
                    "default_key": "high60_lt_3",
                    "series_key": self.id,
                    "direction": "below",
                    "level": 3,
                    "hysteresis": 0.5,
                    "label": "市场很弱",
                },
            ],
            "description_md": "**口径**：后复权收盘价，含当天的 60 个市场交易日；"
            "上市满 60 个交易日、窗口内交易至少 45 天、当天有交易，平高也算。"
            "分母只含符合条件的股票；缺少复权因子时等待补齐。\n"
            "**解读**：高于 20% 提示普涨过热，低于 3% 提示市场很弱。",
        }

    def compute(self, ctx: ComputeContext, dates: list[int]) -> list[SeriesPoint]:
        if not dates:
            return []
        calendar = [day for day in ctx.calendar if day >= 20150101]
        positions = {day: index for index, day in enumerate(calendar)}
        securities = pd.read_sql_query(
            "SELECT sid,ts_code,list_date FROM securities", ctx.connection
        )
        results = []
        # 分块限制内存；每块带上 59 日依赖窗口。
        for offset in range(0, len(dates), 160):
            chunk = dates[offset : offset + 160]
            window = calendar[max(0, positions[chunk[0]] - 59) : positions[chunk[-1]] + 1]
            rows = pd.read_sql_query(
                "SELECT trade_date,sid,close,amount,adj_factor FROM stock_daily "
                "WHERE trade_date BETWEEN ? AND ?",
                ctx.connection,
                params=(window[0], window[-1]),
            )
            results.extend(new_high_points(rows, securities, window, chunk))
        return results
