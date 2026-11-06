"""端到端断点续传、早发布、离线不改数据和 NDJSON 协议。"""

import hashlib
import io
import json
import runpy
import subprocess
import sys
from datetime import datetime
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
    assert all(row["manual"] == row["stored"] for row in summary["manual_new_high_checks"])
