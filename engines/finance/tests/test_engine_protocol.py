"""端到端断点续传、早发布、离线不改数据和 NDJSON 协议。"""

import hashlib
import io
import json
import runpy
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pandas as pd
import pytest
import respx

from finance_engine.db import Database
from finance_engine.engine import update
from finance_engine.protocol import Protocol
from finance_engine.sources.tushare import URL

from .conftest import TOKEN, request_body, response


def events(output):
    return [json.loads(line) for line in output.getvalue().splitlines()]


def assert_retry_state(path, dataset, days, status, attempts):
    db = Database(path)
    try:
        for day in days:
            assert db.conn.execute(
                "SELECT status,attempts FROM dataset_status WHERE dataset=? AND trade_date=?",
                (dataset, day),
            ).fetchone()[:] == (status, attempts)
    finally:
        db.close()


def snapshot(db):
    return {
        table: list(map(tuple, db.conn.execute(f"SELECT * FROM {table}")))
        for table in (
            "stock_daily",
            "index_daily",
            "index_valuation",
            "trade_calendar",
            "dataset_status",
            "indicator_values",
            "indicator_meta",
            "meta",
            "securities",
        )
    }


def test_cli_version_status_missing_token_arguments_and_verify_no_write(tmp_path):
    database = tmp_path / "finance.db"

    def run(*args, stdin=""):
        result = subprocess.run(
            [sys.executable, "-m", "finance_engine", *args],
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf8",
            timeout=20,
        )
        assert all(isinstance(json.loads(line), dict) for line in result.stdout.splitlines())
        return result

    assert run("--version").returncode == 0
    assert run("status", "--db", str(database)).returncode == 0
    assert not database.exists()
    missing = run("update", "--db", str(database))
    assert missing.returncode == 3 and "TOKEN_MISSING" in missing.stdout
    assert run("update", "--db", "relative.db").returncode == 2
    assert run("update", "--db", str(database), "--token", TOKEN).returncode == 2
    assert not database.exists()


def test_cli_keeps_redirected_stderr_in_utf8(monkeypatch):
    monkeypatch.setenv("PYTHONIOENCODING", "cp1252")
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from finance_engine.__main__ import main; "
            "main(['--version']); sys.stderr.write('中文诊断')",
        ],
        capture_output=True,
        text=True,
        encoding="utf8",
        check=True,
        timeout=20,
    )
    assert result.stderr == "中文诊断"


@respx.mock
def test_first_request_network_failure_only_writes_run_log(tmp_path, client):
    path = tmp_path / "finance.db"
    db = Database(path)
    before = snapshot(db)
    db.close()
    respx.post(URL).mock(side_effect=httpx.ConnectError("secret " + TOKEN))
    output = io.StringIO()
    assert (
        update(
            path,
            client,
            Protocol(output, TOKEN),
            datetime.fromisoformat("2026-11-07T20:00:00+08:00"),
        )
        == 4
    )
    db = Database(path)
    assert snapshot(db) == before
    row = db.conn.execute("SELECT * FROM run_log").fetchone()
    assert row["error_code"] == "NETWORK"
    assert TOKEN not in output.getvalue() and TOKEN not in str(dict(row))
    db.close()
    assert events(output)[-1]["status"] == "failed"


def fixture_handler(interrupt=None):
    days = [int(day.strftime("%Y%m%d")) for day in pd.bdate_range("2015-01-05", periods=80)]
    calls = []

    def handler(request):
        body = request_body(request)
        api, params, fields = body["api_name"], body["params"], body["fields"].split(",")
        calls.append((api, dict(params)))
        if api == "trade_cal":
            rows = [{"cal_date": str(day), "is_open": 1} for day in days]
        elif api == "stock_basic":
            rows = (
                [
                    {
                        "ts_code": f"{i:06}.SH",
                        "name": "测试",
                        "exchange": "SSE",
                        "market": "主板",
                        "list_date": "20100101",
                        "delist_date": None,
                        "list_status": "L",
                    }
                    for i in range(1, 22)
                ]
                if params["list_status"] == "L"
                else []
            )
        elif api in ("daily", "adj_factor"):
            day = int(params["trade_date"])
            if interrupt and api == "daily" and day == days[4]:
                raise KeyboardInterrupt()
            rows = [
                {
                    "ts_code": f"{i:06}.SH",
                    "trade_date": str(day),
                    "close": days.index(day) + 1,
                    "amount": i + days.index(day),
                    "adj_factor": 1,
                }
                for i in range(1, 22)
            ]
        else:
            rows = [
                {
                    "ts_code": params["ts_code"],
                    "trade_date": str(day),
                    "close": 1000,
                    "pe": 10,
                    "pe_ttm": 13.59,
                    "pb": 1.34,
                }
                for day in days
                if int(params["start_date"]) <= day <= int(params["end_date"])
            ]
        return response(fields, rows)

    return days, calls, handler


def indicator_hash(path):
    db = Database(path)
    rows = list(
        map(
            tuple,
            db.conn.execute(
                "SELECT series_key,trade_date,value,extra_json FROM indicator_values ORDER BY 1,2"
            ),
        )
    )
    value = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
    db.close()
    return value


@respx.mock
def test_interruption_resume_matches_uninterrupted_and_publishes_latest_early(tmp_path, client):
    days, _, handler = fixture_handler(interrupt=True)
    path = tmp_path / "resume.db"
    output = io.StringIO()
    respx.post(URL).mock(side_effect=handler)
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    with pytest.raises(KeyboardInterrupt):
        update(path, client, Protocol(output, TOKEN), now)
    messages = events(output)
    recent_stage = next(i for i, row in enumerate(messages) if row.get("stage") == "recent")
    backfill_stage = next(i for i, row in enumerate(messages) if row.get("stage") == "backfill")
    assert any(
        row["type"] == "indicator_updated"
        and row["indicator"] == "new_high_60d_share"
        and row["through"] == str(days[-1])
        for row in messages[recent_stage:backfill_stage]
    )
    db = Database(path)
    assert db.through()["new_high_60d_share"] == str(days[-1])
    db.close()
    _, calls, handler = fixture_handler()
    respx.post(URL).mock(side_effect=handler)
    assert update(path, client, Protocol(io.StringIO(), TOKEN), now) == 0
    fetched = [int(params["trade_date"]) for api, params in calls if api == "daily"]
    assert days[0] not in fetched and days[-1] in fetched
    clean = tmp_path / "clean.db"
    assert update(clean, client, Protocol(io.StringIO(), TOKEN), now) == 0
    assert indicator_hash(path) == indicator_hash(clean)
    db = Database(path)
    assert (
        db.conn.execute(
            "SELECT count(*) FROM dataset_status WHERE dataset='stock_daily' AND status='ok'"
        ).fetchone()[0]
        == 80
    )
    db.close()


@respx.mock
def test_verify_does_not_create_database(client, tmp_path):
    from finance_engine.engine import verify

    respx.post(URL).mock(
        side_effect=lambda request: response(request_body(request)["fields"].split(","), [])
    )
    verify(client)
    assert list(tmp_path.iterdir()) == []


@respx.mock
def test_recalculation_is_not_new_and_full_rebuild_replaces_only_selected_cache(tmp_path, client):
    _, _, handler = fixture_handler()
    respx.post(URL).mock(side_effect=handler)
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    path = tmp_path / "finance.db"
    personal = tmp_path / "workbench.db"
    personal.write_bytes("用户数据不能修改".encode())
    assert update(path, client, Protocol(io.StringIO(), TOKEN), now) == 0
    expected = indicator_hash(path)
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), now) == 0
    assert events(output)[-1]["new_dates"] == {}
    assert indicator_hash(path) == expected
    assert update(path, client, Protocol(io.StringIO(), TOKEN), now, "full-rebuild") == 0
    assert indicator_hash(path) == expected
    assert personal.read_bytes() == "用户数据不能修改".encode()


@respx.mock
def test_missing_factor_is_pending_and_retried_without_shrinking_denominator(tmp_path, client):
    days, calls, handler = fixture_handler()
    missing_day = days[-20]

    def incomplete(request):
        body = request_body(request)
        result = handler(request)
        if body["api_name"] == "adj_factor" and body["params"]["trade_date"] == str(missing_day):
            payload = result.json()
            payload["data"]["items"] = payload["data"]["items"][1:]
            return httpx.Response(200, json=payload)
        return result

    path = tmp_path / "finance.db"
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    respx.post(URL).mock(side_effect=incomplete)
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), now) == 0
    assert events(output)[-1]["status"] == "partial"
    db = Database(path)
    assert (
        db.conn.execute(
            "SELECT count(*) FROM stock_daily WHERE trade_date=?", (missing_day,)
        ).fetchone()[0]
        == 21
    )
    value_sql = (
        "SELECT value FROM indicator_values WHERE series_key='new_high_60d_share' AND trade_date=?"
    )
    assert db.conn.execute(value_sql, (days[-1],)).fetchone()[0] is None
    db.close()
    calls.clear()
    respx.post(URL).mock(side_effect=handler)
    assert update(path, client, Protocol(io.StringIO(), TOKEN), now) == 0
    assert any(
        api == "adj_factor" and params["trade_date"] == str(missing_day) for api, params in calls
    )
    db = Database(path)
    assert db.conn.execute(value_sql, (days[-1],)).fetchone()[0] == 100
    db.close()


@respx.mock
def test_unknown_code_and_possible_change_are_warnings_and_other_dates_continue(tmp_path, client):
    days, _, handler = fixture_handler()
    unknown_day, match_day = map(str, days[-3:-1])

    def with_code_changes(request):
        body = request_body(request)
        result = handler(request)
        if body["api_name"] != "daily":
            return result
        day = body["params"]["trade_date"]
        if day not in (unknown_day, match_day):
            return result
        payload = result.json()
        first, second = payload["data"]["items"][:2]
        if day == unknown_day:
            payload["data"]["items"].append(["999999.SH", *first[1:]])
        else:
            second[2:] = first[2:]
        return httpx.Response(200, json=payload)

    path = tmp_path / "finance.db"
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    respx.post(URL).mock(side_effect=with_code_changes)
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), now) == 0
    messages = events(output)
    assert messages[-1]["status"] == "partial"
    notices = [event for event in messages if event["type"] == "warning"]
    assert {(event["code"], event["trade_date"]) for event in notices} == {
        ("POSSIBLE_CODE_CHANGE", unknown_day),
        ("POSSIBLE_CODE_CHANGE", match_day),
        ("DATA_NOT_READY", unknown_day),
    }
    assert all(
        not event["retryable"] for event in notices if event["code"] == "POSSIBLE_CODE_CHANGE"
    )
    db = Database(path)
    assert (
        db.conn.execute(
            "SELECT status FROM dataset_status WHERE dataset='stock_daily' AND trade_date=?",
            (unknown_day,),
        ).fetchone()[0]
        == "pending"
    )
    assert (
        db.conn.execute(
            "SELECT count(*) FROM stock_daily WHERE trade_date=?", (match_day,)
        ).fetchone()[0]
        == 21
    )
    assert db.through()["top5_turnover_share"] == str(days[-1])
    assert db.through()["new_high_60d_share"] == str(days[-4])
    db.close()

    respx.post(URL).mock(side_effect=handler)
    assert update(path, client, Protocol(io.StringIO(), TOKEN), now) == 0
    db = Database(path)
    assert db.through()["new_high_60d_share"] == str(days[-1])
    db.close()


@respx.mock
@pytest.mark.parametrize("mainland_pair", [False, True])
def test_known_bj_quote_match_only_keeps_mainland_pairs_in_ndjson(
    tmp_path, client, caplog, mainland_pair
):
    days, _, handler = fixture_handler()
    latest = str(days[-1])

    def with_bj_match(request):
        body = request_body(request)
        result = handler(request)
        payload = result.json()
        rows = payload["data"]["items"]
        if body["api_name"] == "stock_basic" and body["params"]["list_status"] == "L":
            rows.append(["920001.BJ", *rows[0][1:]])
        if body["api_name"] == "daily" and body["params"]["trade_date"] == latest:
            if mainland_pair:
                rows[1][2:] = rows[0][2:]
            rows.append(["920001.BJ", *rows[0][1:]])
        return httpx.Response(200, json=payload)

    respx.post(URL).mock(side_effect=with_bj_match)
    output = io.StringIO()
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    assert update(tmp_path / "finance.db", client, Protocol(output, TOKEN), now) == 0
    messages = events(output)
    warnings = [event for event in messages if event["type"] == "warning"]
    if mainland_pair:
        assert [(event["code"], event["trade_date"]) for event in warnings] == [
            ("POSSIBLE_CODE_CHANGE", latest)
        ]
        assert "000001.SH / 000002.SH" in warnings[0]["message"]
        assert ".BJ" not in warnings[0]["message"]
    else:
        assert not warnings
    assert messages[-1]["status"] == "ok"
    assert "涉及北交所的疑似代码变更" in caplog.text
    assert "920001.BJ" in caplog.text


@respx.mock
def test_unknown_bj_and_nonpositive_turnover_do_not_block_hs_indicators(tmp_path, client):
    days, calls, handler = fixture_handler()
    latest = str(days[-1])
    only_unknown_bj = False

    def with_bj_and_suspended_stocks(request):
        body = request_body(request)
        result = handler(request)
        if body["api_name"] != "daily" or body["params"]["trade_date"] != latest:
            return result
        payload = result.json()
        rows = payload["data"]["items"]
        bj_row = ["920001.BJ", *rows[0][1:]]
        for row, amount in zip(rows[1:5], [0, 0, -1, -1], strict=True):
            row[3] = amount
        payload["data"]["items"] = [bj_row] if only_unknown_bj else [*rows, bj_row]
        return httpx.Response(200, json=payload)

    path = tmp_path / "finance.db"
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    respx.post(URL).mock(side_effect=with_bj_and_suspended_stocks)
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), now) == 0
    messages = events(output)
    assert [(e["code"], e["trade_date"]) for e in messages if e["type"] == "warning"] == [
        ("UNKNOWN_BJ_CODE", latest)
    ]
    assert messages[-1]["status"] == "ok"
    assert messages[-1]["through"]["top5_turnover_share"] == latest
    assert messages[-1]["through"]["new_high_60d_share"] == latest

    only_unknown_bj = True
    calls.clear()
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), now) == 0
    messages = events(output)
    assert messages[-1]["status"] == "partial"
    assert [(e["code"], e["trade_date"]) for e in messages if e["type"] == "warning"] == [
        ("UNKNOWN_BJ_CODE", latest),
        ("DATA_NOT_READY", latest),
    ]
    assert not any(api == "adj_factor" and params["trade_date"] == latest for api, params in calls)
    db = Database(path)
    assert db.conn.execute(
        "SELECT status,last_error FROM dataset_status WHERE dataset='stock_daily' AND trade_date=?",
        (latest,),
    ).fetchone()[:] == ("pending", "日线尚未发布")
    assert (
        db.conn.execute(
            "SELECT count(*) FROM stock_daily WHERE trade_date=?", (latest,)
        ).fetchone()[0]
        == 21
    )
    db.close()


@respx.mock
def test_catalog_retry_cap_skips_both_historical_and_recent_days(tmp_path, client):
    days, calls, handler = fixture_handler()
    historical = str(days[4])
    missing_days = {historical, str(days[-1])}
    temporarily_unavailable = False

    def with_unlisted_code(request):
        body = request_body(request)
        result = handler(request)
        if body["api_name"] != "daily" or body["params"]["trade_date"] not in missing_days:
            return result
        if temporarily_unavailable and body["params"]["trade_date"] == historical:
            return httpx.Response(503)
        payload = result.json()
        rows = payload["data"]["items"]
        payload["data"]["items"] = (
            [] if temporarily_unavailable else [["999999.SH", *rows[0][1:]], *rows]
        )
        return httpx.Response(200, json=payload)

    path = tmp_path / "finance.db"
    first_check = datetime.fromisoformat("2015-05-02T00:05:00+08:00")
    checked_at = first_check
    db = Database(path)
    with db.conn:
        db.mark(
            "stock_daily",
            int(historical),
            "error",
            error="证券目录仍未收录 1 个代码（999999.SH），已停止自动补取",
            attempts=3,
        )
    db.close()
    respx.post(URL).mock(side_effect=with_unlisted_code)
    # 同一北京时间日期内跨过 UTC 午夜，仍只累计一次。
    for hours in (0, 9, 23):
        checked_at = first_check + timedelta(hours=hours)
        assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
        assert_retry_state(path, "stock_daily", missing_days, "pending", 1)

    checked_at = first_check + timedelta(days=1)
    temporarily_unavailable = True
    assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
    temporarily_unavailable = False
    assert_retry_state(path, "stock_daily", missing_days, "pending", 1)

    assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
    assert_retry_state(path, "stock_daily", missing_days, "pending", 2)
    checked_at = first_check + timedelta(days=2)
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), checked_at) == 0
    assert {
        event["trade_date"]
        for event in events(output)
        if event["type"] == "warning"
        and event["code"] == "DATA_NOT_READY"
        and not event["retryable"]
    } == missing_days

    calls.clear()
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), checked_at) == 0
    assert events(output)[-1]["status"] == "partial"
    assert events(output)[-1]["through"]["top5_turnover_share"] == str(days[-2])
    assert not any(params.get("trade_date") in missing_days for _, params in calls)
    assert_retry_state(path, "stock_daily", missing_days, "error", 3)


@respx.mock
def test_ineligible_missing_factor_does_not_block_latest_new_high(tmp_path, client):
    days, _, handler = fixture_handler()
    list_date = str(days[-20])

    def new_listing(request):
        body = request_body(request)
        result = handler(request)
        payload = result.json()
        items = payload["data"]["items"]
        if body["api_name"] == "stock_basic" and items:
            items[0][payload["data"]["fields"].index("list_date")] = list_date
        if body["api_name"] in ("daily", "adj_factor"):
            day = body["params"]["trade_date"]
            if day < list_date or (day == list_date and body["api_name"] == "adj_factor"):
                del items[0]
        return httpx.Response(200, json=payload)

    path = tmp_path / "finance.db"
    now = datetime.fromisoformat("2015-05-01T20:00:00+08:00")
    respx.post(URL).mock(side_effect=new_listing)
    assert update(path, client, Protocol(io.StringIO(), TOKEN), now) == 0
    db = Database(path)
    value, extra = db.conn.execute(
        "SELECT value,extra_json FROM indicator_values WHERE series_key='new_high_60d_share' "
        "AND trade_date=?",
        (days[-1],),
    ).fetchone()
    assert value == 100 and json.loads(extra)["n"] == 20
    db.close()


@respx.mock
def test_missing_factor_retry_limit_persists_across_updates(tmp_path, client):
    days, calls, handler = fixture_handler()
    historical, latest = str(days[-20]), str(days[-1])
    factor_network_failure = False

    def missing_factors(request):
        body = request_body(request)
        result = handler(request)
        if body["api_name"] == "adj_factor" and body["params"]["trade_date"] in (
            historical,
            latest,
        ):
            if factor_network_failure:
                return httpx.Response(503)
            payload = result.json()
            del payload["data"]["items"][0]
            return httpx.Response(200, json=payload)
        return result

    path = tmp_path / "finance.db"
    first_check = datetime.fromisoformat("2015-05-02T00:05:00+08:00")
    checked_at = first_check
    db = Database(path)
    with db.conn:
        db.mark(
            "adj_factor",
            int(historical),
            "error",
            error="复权因子连续三次缺失，已停止自动补取",
            attempts=3,
        )
        db.mark(
            "adj_factor",
            int(latest),
            "pending",
            error="复权因子持续缺失，等待下次取数",
            attempts=2,
        )
    db.close()
    respx.post(URL).mock(side_effect=missing_factors)
    for hours in (0, 9, 23):
        checked_at = first_check + timedelta(hours=hours)
        assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
        assert_retry_state(path, "adj_factor", (historical, latest), "pending", 1)

    checked_at = first_check + timedelta(days=1)
    factor_network_failure = True
    assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
    factor_network_failure = False
    assert_retry_state(path, "adj_factor", (historical, latest), "pending", 1)
    assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
    assert_retry_state(path, "adj_factor", (historical, latest), "pending", 2)
    checked_at = first_check + timedelta(days=2)
    assert update(path, client, Protocol(io.StringIO(), TOKEN), checked_at) == 0
    assert_retry_state(path, "adj_factor", (historical, latest), "error", 3)

    calls.clear()
    output = io.StringIO()
    assert update(path, client, Protocol(output, TOKEN), checked_at) == 0
    assert events(output)[-1]["status"] == "partial"
    assert ("daily", latest) in [(api, params.get("trade_date")) for api, params in calls]
    assert not any(params.get("trade_date") == historical for _, params in calls)
    assert not any(api == "adj_factor" and params["trade_date"] == latest for api, params in calls)
    db = Database(path)
    for day in (historical, latest):
        assert db.conn.execute(
            "SELECT status,attempts FROM dataset_status "
            "WHERE dataset='adj_factor' AND trade_date=?",
            (day,),
        ).fetchone()[:] == ("error", 3)
        assert db.conn.execute(
            "SELECT count(*),count(adj_factor) FROM stock_daily WHERE trade_date=?", (day,)
        ).fetchone()[:] == (21, 20)
    assert (
        db.conn.execute(
            "SELECT value FROM indicator_values WHERE series_key='new_high_60d_share' "
            "AND trade_date=?",
            (latest,),
        ).fetchone()[0]
        is None
    )
    db.close()


@respx.mock
def test_cli_update_restores_legacy_exhausted_dates(tmp_path, client, monkeypatch):
    from finance_engine import __main__ as cli

    days, calls, handler = fixture_handler()
    old_daily, old_factor = days[4:6]
    path = tmp_path / "legacy.db"
    db = Database(path)
    with db.conn:
        db.mark(
            "stock_daily",
            old_daily,
            "error",
            error="证券目录仍未收录 1 个代码（999999.SH），已停止自动补取",
            attempts=3,
        )
        db.mark(
            "adj_factor",
            old_factor,
            "error",
            error="复权因子连续三次缺失，已停止自动补取",
            attempts=3,
        )
    db.close()

    respx.post(URL).mock(side_effect=handler)
    monkeypatch.setattr(cli, "TushareClient", lambda _token: client)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"tushare_token": TOKEN}) + "\n"))
    assert cli.main(["update", "--db", str(path), "--now", "2015-05-02T00:05:00+08:00"]) == 0
    assert any(api == "daily" and params["trade_date"] == str(old_daily) for api, params in calls)
    assert any(
        api == "adj_factor" and params["trade_date"] == str(old_factor) for api, params in calls
    )
    db = Database(path)
    try:
        for dataset, day in (("stock_daily", old_daily), ("adj_factor", old_factor)):
            assert db.conn.execute(
                "SELECT status,last_error FROM dataset_status WHERE dataset=? AND trade_date=?",
                (dataset, day),
            ).fetchone()[:] == ("ok", None)
        assert db.through()["new_high_60d_share"] == str(days[-1])
    finally:
        db.close()


@respx.mock
def test_cancel_during_network_backoff_keeps_cache_and_releases_lock(tmp_path, monkeypatch):
    from finance_engine.cancellation import Cancellation
    from finance_engine.db import database_lock
    from finance_engine.sources.tushare import TushareClient

    path = tmp_path / "cancelled.db"
    db = Database(path)
    before = snapshot(db)
    db.close()
    signal = tmp_path / "cancel"
    cancellation = Cancellation(signal)
    monkeypatch.setattr("finance_engine.cancellation.time.sleep", lambda _delay: signal.touch())
    route = respx.post(URL).mock(side_effect=httpx.ConnectError("模拟离线"))
    client = TushareClient(TOKEN, sleep=cancellation.sleep, check_cancelled=cancellation.check)
    output = io.StringIO()
    try:
        now = datetime.fromisoformat("2026-11-06T20:00:00+08:00")
        assert update(path, client, Protocol(output, TOKEN), now) == 130
        assert route.call_count == 1
        assert events(output)[-2]["code"] == "CANCELLED"
        with database_lock(path):
            db = Database(path)
            try:
                assert snapshot(db) == before
            finally:
                db.close()
    finally:
        client.close()


@respx.mock
def test_registering_an_indicator_is_enough_to_compute_and_publish_it(
    tmp_path, client, monkeypatch
):
    import finance_engine.engine as engine
    from finance_engine.indicators.base import SeriesPoint

    class ExtraIndicator:
        id = "test_registered_indicator"
        depends_on = ["stock_daily"]
        lookback_days = 0

        def meta(self):
            return {"id": self.id, "series": [{"key": self.id}], "default_thresholds": []}

        def compute(self, ctx, dates):
            return [SeriesPoint(self.id, day, 7) for day in dates]

    monkeypatch.setattr(engine, "INDICATORS", [*engine.INDICATORS, ExtraIndicator()])
    days, _, handler = fixture_handler()
    respx.post(URL).mock(side_effect=handler)
    path = tmp_path / "finance.db"
    output = io.StringIO()
    assert (
        update(
            path,
            client,
            Protocol(output, TOKEN),
            datetime.fromisoformat("2015-05-01T20:00:00+08:00"),
        )
        == 0
    )
    db = Database(path)
    assert db.through()[ExtraIndicator.id] == str(days[-1])
    assert (
        db.conn.execute(
            "SELECT count(*) FROM indicator_meta WHERE indicator_id=?", (ExtraIndicator.id,)
        ).fetchone()[0]
        == 1
    )
    db.close()


def validate_schema(value, schema):
    # 标准库检查本协议 JSON Schema 使用的关键字，不增加规格外依赖。
    if "oneOf" in schema:
        options = [
            option
            for option in schema["oneOf"]
            if option["properties"]["type"]["const"] == value["type"]
        ]
        assert len(options) == 1
        validate_schema(value, options[0])
        return
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool}
    if "type" in schema:
        assert isinstance(value, types[schema["type"]])
    if "const" in schema:
        assert value == schema["const"]
    if "enum" in schema:
        assert value in schema["enum"]
    if isinstance(value, dict):
        assert set(schema.get("required", [])).issubset(value)
        for key, child in schema.get("properties", {}).items():
            if key in value:
                validate_schema(value[key], child)
    if isinstance(value, list) and "items" in schema:
        for child in value:
            validate_schema(child, schema["items"])


@respx.mock
def test_output_events_match_json_schema(client, tmp_path):
    _, _, handler = fixture_handler()
    respx.post(URL).mock(side_effect=handler)
    output = io.StringIO()
    update(
        tmp_path / "finance.db",
        client,
        Protocol(output, TOKEN),
        datetime.fromisoformat("2015-05-01T20:00:00+08:00"),
    )
    schema = json.loads(
        (Path(__file__).parents[1] / "finance_engine" / "protocol.schema.json").read_text("utf8")
    )
    for event in events(output):
        validate_schema(event, schema)
    tools = runpy.run_path(str(Path(__file__).parents[1] / "scripts" / "live_validation.py"))
    summary = tools["report"](tmp_path / "finance.db")
    assert summary["new_high_distribution"] == {"P5": 100, "P50": 100, "P95": 100}
    assert len(summary["manual_new_high_checks"]) == 3
    assert summary["manual_sample_seed"] == 20261108
    assert all(row["manual"] == row["stored"] for row in summary["manual_new_high_checks"])
