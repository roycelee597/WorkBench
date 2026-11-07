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
    assert canonical_code(old, effective) == old
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
def test_unknown_history_is_rejected_instead_of_dropped(db, client):
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

    respx.post(URL).mock(side_effect=handler)
    with pytest.raises(EngineError, match="未收录"):
        refresh(db, client, 20150105, 20150105)
    assert db.conn.execute("SELECT count(*) FROM stock_daily").fetchone()[0] == 0


@pytest.mark.parametrize("conflict", [False, True])
@respx.mock
def test_identical_alias_rows_count_once_but_conflicts_are_rejected(db, client, conflict):
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
    if conflict:
        with pytest.raises(EngineError, match="别名数据冲突"):
            refresh(db, client, 20150105, 20150105)
        assert db.conn.execute("SELECT count(*) FROM stock_daily").fetchone()[0] == 0
    else:
        assert refresh(db, client, 20150105, 20150105)
        assert db.conn.execute("SELECT count(*),sum(amount) FROM stock_daily").fetchone()[:] == (
            1,
            100,
        )
