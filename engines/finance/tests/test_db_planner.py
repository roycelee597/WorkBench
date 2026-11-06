"""数据库原子性与规划边界。"""

import sqlite3
from datetime import datetime

import pytest
import respx

from finance_engine.datasets import stock_daily
from finance_engine.db import Database, database_lock
from finance_engine.errors import EngineError
from finance_engine.indicators.base import SeriesPoint
from finance_engine.planner import plan_stock, ready_days
from finance_engine.sources.tushare import URL

from .conftest import request_body, response


def seed(db):
    with db.conn:
        db.conn.execute(
            "INSERT INTO securities VALUES (1,'000001.SZ','测试','SZSE','主板',20000101,NULL,'L',0)"
        )


@respx.mock
def test_day_transaction_rolls_back_and_missing_factor_retains_daily(db, client):
    seed(db)

    def handler(request):
        body = request_body(request)
        fields = body["fields"].split(",")
        return response(
            fields,
            [{"ts_code": "000001.SZ", "trade_date": "20261105", "close": 10, "amount": 100}]
            if body["api_name"] == "daily"
            else [],
        )

    respx.post(URL).mock(side_effect=handler)
    assert not stock_daily.refresh(db, client, 20261105, 20261105)
    assert db.conn.execute("SELECT adj_factor FROM stock_daily").fetchone()[0] is None
    assert (
        db.conn.execute("SELECT status FROM dataset_status WHERE dataset='adj_factor'").fetchone()[
            0
        ]
        == "pending"
    )
    db.conn.execute(
        "CREATE TRIGGER fail_mark BEFORE UPDATE ON dataset_status "
        "WHEN NEW.dataset='adj_factor' BEGIN SELECT RAISE(ABORT,'测试回滚'); END"
    )
    db.conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        stock_daily.refresh(db, client, 20261105, 20261105)
    assert (
        db.conn.execute(
            "SELECT attempts FROM dataset_status WHERE dataset='stock_daily'"
        ).fetchone()[0]
        == 1
    )
    assert db.conn.execute("SELECT count(*) FROM stock_daily").fetchone()[0] == 1


def test_wal_version_lock_and_published_points(db):
    assert db.conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    with database_lock(db.path), pytest.raises(EngineError, match="占用"):
        with database_lock(db.path):
            pass
    db.points([SeriesPoint("x", 20261106, 46), SeriesPoint("x", 20261105, 44)])
    db.points([SeriesPoint("x", 20261106, None, {"status": "pending"})])
    assert db.through() == {"x": "20261106"}
    assert (
        db.conn.execute("SELECT value FROM indicator_values WHERE trade_date=20261106").fetchone()[
            0
        ]
        == 46
    )
    with db.conn:
        db.conn.execute("UPDATE meta SET value='999' WHERE key='schema_version'")
    with pytest.raises(EngineError, match="不兼容"):
        Database(db.path)


def test_ready_times_weekends_pending_and_recent_three():
    days = [20261102, 20261103, 20261104, 20261105, 20261106]
    before = datetime.fromisoformat("2026-11-06T18:59:00+08:00")
    after = datetime.fromisoformat("2026-11-06T19:00:00+08:00")
    assert ready_days(days, before, 19, 20050101) == days[:-1]
    assert ready_days(days, after, 19, 20050101) == days
    states = {(dataset, day): "ok" for day in days for dataset in ("stock_daily", "adj_factor")}
    assert plan_stock(days, states, after).recent == days[-3:]
    states["adj_factor", days[0]] = "pending"
    assert plan_stock(days, states, after).recent == [days[0], *days[-3:]]
    weekend = datetime.fromisoformat("2026-11-08T08:00:00+08:00")
    assert ready_days(days, weekend, 19, 20050101) == days
    assert (
        ready_days(days, datetime.fromisoformat("2026-11-06T15:59:00+08:00"), 16, 20150101)
        == days[:-1]
    )
