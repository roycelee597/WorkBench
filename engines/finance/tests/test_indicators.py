"""合成行情独立核对计算口径与窗口边界。"""

import math

import pandas as pd
import pytest

from finance_engine.indicators import INDICATORS
from finance_engine.indicators.index_valuation import valuation_points
from finance_engine.indicators.new_high_60d import new_high_points
from finance_engine.indicators.top5_turnover import top5_turnover


def test_top5_ceil_ties_suspensions_and_beijing():
    rows = [{"ts_code": f"{i:06}.SH", "amount": 1} for i in range(21)]
    rows += [{"ts_code": "999999.SZ", "amount": 0}, {"ts_code": "888888.BJ", "amount": 9999}]
    point = top5_turnover(20261105, rows)
    assert point.extra == {"n": 21, "k": 2}
    assert point.value == pytest.approx(2 / 21 * 100)
    assert top5_turnover(20261105, list(reversed(rows))) == point
    assert top5_turnover(20261105, []).value is None


def history():
    days = [int(day.strftime("%Y%m%d")) for day in pd.bdate_range("2026-01-01", periods=61)]
    securities = pd.DataFrame(
        [{"sid": sid, "ts_code": f"{sid:06}.SH", "list_date": days[0]} for sid in range(1, 6)]
    )
    rows = pd.DataFrame(
        [
            {"trade_date": day, "sid": sid, "close": 10.0, "amount": 1, "adj_factor": 1.0}
            for day in days
            for sid in range(1, 6)
        ]
    )
    return days, securities, rows


def test_high_60d_44_45_days_listing_and_long_suspension():
    days, securities, rows = history()
    # 末日的窗口从第二天开始：sid1 只有44天、sid2恰45天、sid3上市不足60日。
    rows = rows[~((rows.sid == 1) & rows.trade_date.isin(days[1:17]))]
    rows = rows[~((rows.sid == 2) & rows.trade_date.isin(days[1:16]))]
    securities.loc[securities.sid == 3, "list_date"] = days[2]
    rows = rows[~((rows.sid == 4) & (rows.trade_date != days[-1]))]
    rows.loc[(rows.sid == 5) & (rows.trade_date == days[-1]), "close"] = 9
    point = new_high_points(rows, securities, days, [days[-1]])[0]
    assert point.extra["n"] == 2
    assert point.extra["new_high"] == 1
    assert point.value == 50
    securities.loc[securities.sid == 3, "list_date"] = days[1]
    assert new_high_points(rows, securities, days, [days[-1]])[0].extra["n"] == 3


def test_adjustment_equal_high_and_missing_factor():
    days, securities, rows = history()
    # 除权后未复权价格减半、因子翻倍，后复权价保持相同，仍应计为平高。
    rows.loc[rows.trade_date >= days[30], "close"] = 5
    rows.loc[rows.trade_date >= days[30], "adj_factor"] = 2
    assert new_high_points(rows, securities, days, [days[-1]])[0].value == 100
    rows.loc[(rows.sid == 1) & (rows.trade_date == days[20]), "adj_factor"] = math.nan
    point = new_high_points(rows, securities, days, [days[-1]])[0]
    assert point.value is None and point.extra["status"] == "pending"
    assert point.extra["n"] == 5
    assert new_high_points(rows, securities, days, [days[58]])[0].value is None


def test_suspension_on_today_is_not_in_denominator():
    days, securities, rows = history()
    rows.loc[(rows.sid == 1) & (rows.trade_date == days[-1]), "amount"] = 0
    point = new_high_points(rows, securities, days, [days[-1]])[0]
    assert point.extra["n"] == 4 and point.value == 100


def test_valuation_windows_no_lookahead_invalid_pe_and_manual_rank():
    rows = [
        {"trade_date": int(day.strftime("%Y%m%d")), "pe_ttm": float(index % 7 + 1), "pb": 1}
        for index, day in enumerate(pd.bdate_range("2005-01-03", "2020-01-03"))
    ]
    points = valuation_points("000300.SH", rows)
    prefix = "valuation.000300.SH.pe_ttm."
    first = {
        window: min(
            point.day
            for point in points
            if point.key == prefix + window and point.value is not None
        )
        for window in ("pct_5y", "pct_10y", "pct_all")
    }
    assert first == {"pct_5y": 20090703, "pct_10y": 20140103, "pct_all": 20080103}
    past = valuation_points("000300.SH", rows[:-5])
    assert {(p.key, p.day): p.value for p in past} == {
        (p.key, p.day): p.value for p in points if p.day <= rows[-6]["trade_date"]
    }
    current = rows[-1]
    expected = sum(row["pe_ttm"] <= current["pe_ttm"] for row in rows) / len(rows) * 100
    actual = next(
        p.value for p in points if p.day == current["trade_date"] and p.key == prefix + "pct_all"
    )
    assert actual == pytest.approx(expected)
    rows[-1]["pe_ttm"] = -1
    invalid = valuation_points("000300.SH", rows, {rows[-1]["trade_date"]})
    assert all(p.value is None for p in invalid if ".pe_ttm." in p.key)
    assert all(p.value is not None for p in invalid if ".pb." in p.key)


def test_metadata_nine_defaults_and_24_valuation_series():
    metadata = [indicator.meta() for indicator in INDICATORS]
    assert sum(len(meta["default_thresholds"]) for meta in metadata) == 9
    assert metadata[0]["views"]["default"] == "daily"
    assert len(metadata[2]["series"]) == 24
