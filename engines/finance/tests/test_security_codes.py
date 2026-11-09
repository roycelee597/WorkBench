"""代码变更前后使用同一证券身份，不丢历史也不重置上市时间。"""

import pandas as pd
import pytest
import respx

from finance_engine.datasets.security_codes import CODE_CHANGES, canonical_code, historical_code
from finance_engine.datasets.stock_daily import refresh
from finance_engine.errors import EngineError
from finance_engine.indicators.base import ComputeContext
from finance_engine.indicators.new_high_60d import NewHigh60d
from finance_engine.sources.tushare import URL

from .conftest import request_body, response


@pytest.mark.parametrize("old,change", CODE_CHANGES.items())
def test_code_resolution_is_date_aware(old, change):
    current, effective, _ = change
    assert canonical_code(old, effective - 1) == current
    assert canonical_code(old, effective) == current
    assert historical_code(current, effective - 1) == old
    assert historical_code(current, effective) == current


@respx.mock
def test_new_high_window_remains_continuous_across_code_change(db, client):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'001872.SZ','测试','SZSE','主板',19930505,NULL,'L',0)"
        )
    days = [int(day.strftime("%Y%m%d")) for day in pd.bdate_range("2018-11-01", periods=61)]

    def handler(request):
        body = request_body(request)
        day = int(body["params"]["trade_date"])
        code = historical_code("001872.SZ", day)
        return response(
            body["fields"].split(","),
            [
                {
                    "ts_code": code,
                    "trade_date": str(day),
                    "close": 10,
                    "amount": 100,
                    "adj_factor": 1,
                }
            ],
        )

    respx.post(URL).mock(side_effect=handler)
    for day in days:
        assert refresh(db, client, day, days[-1])
    assert db.conn.execute("SELECT count(DISTINCT sid) FROM stock_daily").fetchone()[0] == 1
    point = NewHigh60d().compute(ComputeContext(db.conn, days), [days[-1]])[0]
    assert point.value == 100 and point.extra["n"] == 1


@respx.mock
def test_unknown_history_marks_day_pending_and_preserves_cache(db, client):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'000001.SZ','测试','SZSE','主板',19910403,NULL,'L',0)"
        )
        db.conn.execute("INSERT INTO stock_daily VALUES (20150105,1,9,90,1,'tushare')")
        db.mark("stock_daily", 20150105, "ok", 1)

    def handler(request):
        body = request_body(request)
        return response(
            body["fields"].split(","),
            [
                {
                    "ts_code": "999999.SZ",
                    "trade_date": "20150105",
                    "close": 10,
                    "amount": 100,
                    "adj_factor": 1,
                }
            ],
        )

    route = respx.post(URL).mock(side_effect=handler)
    assert not refresh(db, client, 20150105, 20150105)
    assert route.call_count == 1
    status, error = db.conn.execute("SELECT status,last_error FROM dataset_status").fetchone()
    assert status == "pending" and "999999.SZ" in error
    assert db.conn.execute("SELECT close,amount FROM stock_daily").fetchone()[:] == (9, 90)


@pytest.mark.parametrize("conflict", [False, True])
@respx.mock
def test_alias_rows_count_once_and_inactive_backfill_does_not_override(db, client, conflict):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'001872.SZ','测试','SZSE','主板',19930505,NULL,'L',0)"
        )

    def handler(request):
        body = request_body(request)
        rows = [
            {
                "ts_code": code,
                "trade_date": "20150105",
                "close": 10,
                "amount": 101 if conflict and code == "001872.SZ" else 100,
                "adj_factor": 1,
            }
            for code in ("000022.SZ", "001872.SZ")
        ]
        return response(body["fields"].split(","), rows)

    respx.post(URL).mock(side_effect=handler)
    warnings = []
    assert refresh(db, client, 20150105, 20150105, warn=warnings.append)
    assert not warnings
    assert db.conn.execute("SELECT count(*),sum(amount) FROM stock_daily").fetchone()[:] == (1, 100)


@pytest.mark.parametrize("day,expected", [(20191213, 8.333), (20191216, 8.334)])
@respx.mock
def test_conflicting_factors_use_effective_code_before_and_on_change(db, client, day, expected):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'001914.SZ','测试','SZSE','主板',19940928,NULL,'L',0)"
        )

    def handler(request):
        body = request_body(request)
        return response(
            body["fields"].split(","),
            [
                {
                    "ts_code": code,
                    "trade_date": str(day),
                    "close": 9.96,
                    "amount": 66315.909,
                    "adj_factor": factor,
                }
                for code, factor in (("000043.SZ", 8.333), ("001914.SZ", 8.334))
            ],
        )

    respx.post(URL).mock(side_effect=handler)
    assert refresh(db, client, day, day)
    assert db.conn.execute("SELECT count(*),adj_factor FROM stock_daily").fetchone()[:] == (
        1,
        expected,
    )


@respx.mock
def test_missing_effective_code_is_not_replaced_with_inactive_backfill(db, client):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'001914.SZ','测试','SZSE','主板',19940928,NULL,'L',0)"
        )

    def handler(request):
        body = request_body(request)
        return response(
            body["fields"].split(","),
            [
                {
                    "ts_code": "001914.SZ",
                    "trade_date": "20190606",
                    "close": 9.96,
                    "amount": 100,
                    "adj_factor": 8.334,
                }
            ],
        )

    respx.post(URL).mock(side_effect=handler)
    with pytest.raises(EngineError, match="缺少当日正式有效代码"):
        refresh(db, client, 20190606, 20190606)
    assert db.conn.execute("SELECT count(*) FROM stock_daily").fetchone()[0] == 0


@respx.mock
def test_missing_effective_factor_stays_pending_despite_backfill_factor(db, client):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'001914.SZ','测试','SZSE','主板',19940928,NULL,'L',0)"
        )

    def handler(request):
        body = request_body(request)
        return response(
            body["fields"].split(","),
            [
                {
                    "ts_code": code,
                    "trade_date": "20190606",
                    "close": 9.96,
                    "amount": 100,
                    "adj_factor": factor,
                }
                for code, factor in (("000043.SZ", None), ("001914.SZ", 8.334))
            ],
        )

    respx.post(URL).mock(side_effect=handler)
    assert not refresh(db, client, 20190606, 20190606)
    assert db.conn.execute("SELECT adj_factor FROM stock_daily").fetchone()[0] is None
    assert (
        db.conn.execute("SELECT status FROM dataset_status WHERE dataset='adj_factor'").fetchone()[
            0
        ]
        == "pending"
    )


@respx.mock
def test_duplicate_effective_rows_are_still_rejected(db, client):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'001914.SZ','测试','SZSE','主板',19940928,NULL,'L',0)"
        )

    def handler(request):
        body = request_body(request)
        row = {
            "ts_code": "000043.SZ",
            "trade_date": "20190606",
            "close": 9.96,
            "amount": 100,
            "adj_factor": 8.333,
        }
        return response(
            body["fields"].split(","), [row, row] if body["api_name"] == "daily" else [row]
        )

    respx.post(URL).mock(side_effect=handler)
    with pytest.raises(EngineError, match="重复证券"):
        refresh(db, client, 20190606, 20190606)
    assert db.conn.execute("SELECT count(*) FROM stock_daily").fetchone()[0] == 0
