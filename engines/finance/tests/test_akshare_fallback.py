"""只使用临时库和模拟源，禁止估值、历史个股及日期错配进入备用通道。"""

import io
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pandas as pd
import pytest
import respx

from finance_engine.datasets import index_daily
from finance_engine.db import Database
from finance_engine.engine import update
from finance_engine.errors import EngineError
from finance_engine.indicators.base import SeriesPoint
from finance_engine.protocol import Protocol
from finance_engine.sources.akshare_fallback import AkshareFallback
from finance_engine.sources.tushare import URL

from .conftest import request_body, response

NOW = datetime.fromisoformat("2026-11-13T20:00:00+08:00")


@pytest.fixture
def ak(monkeypatch):
    module = SimpleNamespace(
        stock_index_pe_lg=Mock(),
        stock_index_pb_lg=Mock(),
        stock_zh_a_hist=Mock(),
        stock_a_high_low_statistics=Mock(),
        tool_trade_date_hist_sina=Mock(
            return_value=pd.DataFrame({"trade_date": ["2004-12-31", "2026-11-12", "2026-11-13"]})
        ),
        stock_zh_index_daily=Mock(
            return_value=pd.DataFrame({"date": ["2026-11-12", "2026-11-13"], "close": [4500, 4520]})
        ),
        stock_zh_a_spot_em=Mock(
            return_value=pd.DataFrame(
                {
                    "代码": ["600000", "000001", "300001", "920001", "830001"],
                    "成交额": [90000, 6000, 4000, 999999, 999999],
                }
            )
        ),
    )
    loader = Mock(return_value=module)
    monkeypatch.setattr("finance_engine.sources.akshare_fallback.import_module", loader)
    return module, loader


def provider(enabled=True, **kwargs):
    return AkshareFallback(enabled, clock=lambda: NOW, **kwargs)


def test_optional_import_is_lazy_disabled_and_missing_are_silent(ak):
    _module, loader = ak
    source = provider(False)
    assert source.calendar(2026) is None
    assert source.index([20261113]) is None
    assert source.turnover(20261113) is None
    loader.assert_not_called()
    source = provider()
    loader.assert_not_called()
    loader.side_effect = ModuleNotFoundError("akshare")
    assert source.calendar(2026) is None
    assert source.turnover(20261113) is None
    assert loader.call_count == 1


def test_calendar_only_reports_known_open_days_and_preserves_date_provenance(ak):
    rows = provider().calendar(2026)
    assert rows == [
        {"cal_date": 20261112, "is_open": 1, "source": "akshare"},
        {"cal_date": 20261113, "is_open": 1, "source": "akshare"},
    ]


def test_today_snapshot_excludes_bj_and_only_computes_top5(ak):
    point = provider().turnover(20261113)
    assert point is not None and point.value == 90
    assert point.extra == {"n": 3, "k": 1, "source": "akshare"}
    assert point.key == "top5_turnover_share"


@pytest.mark.parametrize("day", [20261112, 20261114, 20150105])
def test_snapshot_never_substitutes_historical_or_future_day(day, ak):
    module, loader = ak
    assert provider().turnover(day) is None
    loader.assert_not_called()
    module.stock_zh_a_spot_em.assert_not_called()


def test_midnight_snapshot_is_discarded(ak):
    clock = Mock(side_effect=[NOW, datetime.fromisoformat("2026-11-14T00:00:00+08:00")])
    assert AkshareFallback(clock=clock).turnover(20261113) is None


def test_real_intraday_clock_cannot_be_overridden_by_future_now(ak):
    source = AkshareFallback(clock=lambda: NOW.replace(hour=15, minute=59))
    assert source.turnover(20261113) is None
    ak[1].assert_not_called()


def test_index_backup_does_not_write_intraday_or_future_close(ak):
    source = AkshareFallback(clock=lambda: NOW.replace(hour=18))
    assert source.index([20261113, 20261116]) is None
    ak[1].assert_not_called()
    rows = source.index([20261112, 20261113])
    assert rows == [
        {"ts_code": "000300.SH", "trade_date": 20261112, "close": 4500, "source": "akshare"}
    ]


@pytest.mark.parametrize("amounts", [[90000, float("nan")], [90000, float("inf")]])
def test_missing_snapshot_amount_does_not_silently_change_denominator(amounts, ak):
    module, _loader = ak
    module.stock_zh_a_spot_em.return_value = pd.DataFrame(
        {"代码": ["600000", "000001"], "成交额": amounts}
    )
    warning = Mock()
    assert provider(warn=warning).turnover(20261113) is None
    assert warning.call_args[0][0].code == "AKSHARE_FAILED"


def test_cancel_never_calls_optional_source(ak):
    def cancelled():
        raise EngineError("CANCELLED", "已取消")

    _module, loader = ak
    with pytest.raises(EngineError, match="已取消"):
        provider(check_cancelled=cancelled).calendar(2026)
    loader.assert_not_called()


def test_third_party_prints_never_pollute_ndjson_stdout(ak, capsys):
    module, loader = ak
    frame = module.stock_zh_a_spot_em.return_value

    def load(_name):
        print("模拟第三方导入输出")
        return module

    def snapshot():
        print("模拟第三方取数输出")
        return frame

    loader.side_effect = load
    module.stock_zh_a_spot_em.side_effect = snapshot
    assert provider().turnover(20261113) is not None
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "模拟第三方导入输出" in captured.err and "模拟第三方取数输出" in captured.err


@respx.mock
def test_overlay_falls_back_only_after_failure_and_primary_cache_has_priority(db, client, ak):
    source = provider()
    module, loader = ak
    route = respx.post(URL).mock(
        return_value=response(
            index_daily.FIELDS,
            [
                {"ts_code": "000300.SH", "trade_date": 20261113, "close": 4530},
            ],
        )
    )
    assert index_daily.refresh(db, client, [20261113], 20261113, fallback=source)
    loader.assert_not_called()
    route.mock(side_effect=httpx.ConnectError("离线"))
    assert index_daily.refresh(db, client, [20261112, 20261113], 20261113, fallback=source)
    rows = [
        tuple(row)
        for row in db.conn.execute(
            "SELECT trade_date,close,source FROM index_daily ORDER BY trade_date"
        )
    ]
    assert rows == [(20261112, 4500, "akshare"), (20261113, 4530, "tushare")]
    module.stock_zh_index_daily.assert_called_with(symbol="sh000300")
    route.mock(
        side_effect=None,
        return_value=response(
            index_daily.FIELDS,
            [
                {"ts_code": "000300.SH", "trade_date": 20261112, "close": 4510},
            ],
        ),
    )
    assert index_daily.refresh(db, client, [20261112], 20261113, fallback=source)
    assert (
        db.conn.execute("SELECT source FROM index_daily WHERE trade_date=20261112").fetchone()[0]
        == "tushare"
    )


@respx.mock
def test_total_primary_failure_only_writes_allowed_backup_data(tmp_path, client, ak):
    respx.post(URL).mock(side_effect=httpx.ConnectError("主源离线"))
    output = io.StringIO()
    path = tmp_path / "finance.db"
    assert update(path, client, Protocol(output), NOW, fallback=provider()) == 0
    db = Database(path)
    try:
        # 备用快照绝不变成个股历史，也不参与新高／估值计算。
        for table in ("stock_daily", "index_valuation", "securities"):
            assert db.conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
        points = [
            tuple(row)
            for row in db.conn.execute("SELECT series_key,trade_date,value FROM indicator_values")
        ]
        assert points == [("top5_turnover_share", 20261113, 90)]
        assert (
            db.conn.execute(
                "SELECT json_extract(extra_json,'$.source') FROM indicator_values"
            ).fetchone()[0]
            == "akshare"
        )
        assert (
            db.conn.execute("SELECT count(*) FROM index_daily WHERE source='akshare'").fetchone()[0]
            == 2
        )
        assert all(
            row[0] == "akshare"
            for row in db.conn.execute(
                "SELECT source FROM dataset_status WHERE dataset='trade_cal'"
            )
        )
        assert db.conn.execute("SELECT status FROM run_log").fetchone()[0] == "partial"
        assert (
            db.conn.execute(
                "SELECT count(*) FROM dataset_status "
                "WHERE dataset LIKE 'index_valuation.%' AND status='pending'"
            ).fetchone()[0]
            == 3
        )
        assert {name.split(":")[0] for name in client.calls} == {"trade_cal", "stock_basic"}
        for name in (
            "stock_index_pe_lg",
            "stock_index_pb_lg",
            "stock_zh_a_hist",
            "stock_a_high_low_statistics",
        ):
            getattr(ak[0], name).assert_not_called()
    finally:
        db.close()


@respx.mock
def test_no_optional_module_preserves_first_failure_no_write_rule(db, client, ak):
    from .test_engine_protocol import snapshot

    before = snapshot(db)
    respx.post(URL).mock(side_effect=httpx.ConnectError("离线"))
    _module, loader = ak
    loader.side_effect = ModuleNotFoundError("未安装 akshare")
    assert update(db.path, client, Protocol(io.StringIO()), NOW, fallback=provider()) == 4
    assert snapshot(db) == before


@respx.mock
def test_disabled_fallback_preserves_primary_error_and_cache(db, client, ak):
    from .test_engine_protocol import snapshot

    before = snapshot(db)
    respx.post(URL).mock(side_effect=httpx.ConnectError("离线"))
    assert update(db.path, client, Protocol(io.StringIO()), NOW, fallback=provider(False)) == 4
    assert snapshot(db) == before
    ak[1].assert_not_called()


def test_primary_cancellation_never_enters_backup_channel(db, client, ak):
    client.fetch = Mock(side_effect=EngineError("CANCELLED", "已取消"))
    assert update(db.path, client, Protocol(io.StringIO()), NOW, fallback=provider()) == 130
    ak[1].assert_not_called()


def test_partial_backup_keeps_cached_day_completion_when_that_day_is_absent(db, client, ak):
    with db.conn:
        db.conn.execute("INSERT INTO index_daily VALUES ('000300.SH',20261111,4400,'tushare')")
        db.mark("index_daily.000300.SH", 20261111, "ok", 1, fetched_at=12345)
    before = tuple(db.conn.execute("SELECT * FROM dataset_status").fetchone())
    client.fetch = Mock(side_effect=EngineError("NETWORK", "离线", retryable=True))
    assert index_daily.refresh(
        db, client, [20261111, 20261112, 20261113], 20261113, fallback=provider()
    )
    assert (
        tuple(db.conn.execute("SELECT * FROM dataset_status WHERE trade_date=20261111").fetchone())
        == before
    )
    assert db.conn.execute(
        "SELECT close,source FROM index_daily WHERE trade_date=20261111"
    ).fetchone()[:] == (4400, "tushare")


@respx.mock
def test_snapshot_cannot_replace_valid_tushare_point(db, client, ak):
    db.points([SeriesPoint("top5_turnover_share", 20261113, 44.2, {"n": 5217, "k": 261})])
    respx.post(URL).mock(side_effect=httpx.ConnectError("离线"))
    assert update(db.path, client, Protocol(io.StringIO()), NOW, fallback=provider()) == 0
    assert db.conn.execute("SELECT value FROM indicator_values").fetchone()[0] == 44.2
    ak[0].stock_zh_a_spot_em.assert_not_called()


@respx.mock
def test_backdated_now_never_labels_current_snapshot_as_history(db, client, ak):
    respx.post(URL).mock(side_effect=httpx.ConnectError("离线"))
    source = AkshareFallback(clock=lambda: datetime.fromisoformat("2026-11-14T12:00:00+08:00"))
    assert update(db.path, client, Protocol(io.StringIO()), NOW, fallback=source) == 0
    assert db.conn.execute("SELECT count(*) FROM indicator_values").fetchone()[0] == 0
    ak[0].stock_zh_a_spot_em.assert_not_called()


@respx.mock
def test_verify_never_uses_backup_to_claim_tushare_connection_success(client, ak):
    from finance_engine.engine import verify

    respx.post(URL).mock(side_effect=httpx.ConnectError("离线"))
    with pytest.raises(EngineError):
        verify(client)
    ak[1].assert_not_called()


@respx.mock
def test_successful_primary_run_never_imports_or_calls_optional_source(db, client, ak):
    def handler(request):
        body = request_body(request)
        api, params, fields = body["api_name"], body["params"], body["fields"].split(",")
        rows = []
        if api == "trade_cal":
            rows = [{"cal_date": day, "is_open": 1} for day in (20261112, 20261113)]
        elif api == "stock_basic" and params["list_status"] == "L":
            rows = [
                {
                    "ts_code": "600000.SH",
                    "name": "测试",
                    "exchange": "SSE",
                    "market": "主板",
                    "list_date": "20000101",
                    "delist_date": None,
                    "list_status": "L",
                }
            ]
        elif api in ("index_daily", "index_dailybasic"):
            rows = [
                {
                    "ts_code": params["ts_code"],
                    "trade_date": day,
                    "close": 4500,
                    "pe": 15,
                    "pe_ttm": 15,
                    "pb": 1.5,
                }
                for day in (20261112, 20261113)
            ]
        elif api in ("daily", "adj_factor"):
            rows = [
                {
                    "ts_code": "600000.SH",
                    "trade_date": int(params["trade_date"]),
                    "close": 10,
                    "amount": 100,
                    "adj_factor": 1,
                }
            ]
        return response(fields, rows)

    respx.post(URL).mock(side_effect=handler)
    assert update(db.path, client, Protocol(io.StringIO()), NOW, fallback=provider()) == 0
    ak[1].assert_not_called()
    assert (
        db.conn.execute("SELECT count(*) FROM stock_daily WHERE source='tushare'").fetchone()[0]
        == 2
    )
