"""F1 本机实测工具：凭据仅从环境进入内存，报告与数据库里均不输出原文。"""

import argparse
import json
import os
import time
import uuid
from datetime import datetime
from pathlib import Path

import httpx
import numpy as np

from finance_engine.db import Database, timestamp
from finance_engine.engine import update
from finance_engine.errors import EngineError, redact
from finance_engine.indicators.top5_turnover import top5_turnover
from finance_engine.planner import SHANGHAI
from finance_engine.protocol import Protocol
from finance_engine.sources.tushare import URL, TushareClient


def probes(token: str, include_rate_limit: bool) -> dict:
    results = {}
    with httpx.Client(timeout=30, follow_redirects=False) as http:

        def request(api, params, fields):
            response = http.post(
                URL, json={"api_name": api, "token": token, "params": params, "fields": fields}
            )
            response.raise_for_status()
            return response.json()

        pages = [
            request(
                "daily",
                {"trade_date": "20261105", "limit": 3, "offset": offset},
                "ts_code,trade_date,amount",
            )
            for offset in (0, 3)
        ]
        full = request(
            "daily",
            {"trade_date": "20261105", "limit": 6000, "offset": 0},
            "ts_code,trade_date,amount",
        )
        if any(item.get("code") != 0 for item in [*pages, full]):
            raise EngineError("PERMISSION_DENIED", "分页实测请求失败，请先验证 token 与权限")
        first, second, all_rows = [item["data"]["items"] for item in [*pages, full]]
        results["daily_pagination"] = {
            "limit_respected": len(first) == 3 and len(second) == 3,
            "offset_matches_full": first == all_rows[:3] and second == all_rows[3:6],
            "full_rows": len(all_rows),
        }
        fields = full["data"]["fields"]
        point = top5_turnover(20261105, [dict(zip(fields, row, strict=True)) for row in all_rows])
        results["top5_reference"] = {"date": 20261105, "value": point.value, **point.extra}
        results["valuation_reference"] = {}
        for code in ("000300.SH", "399006.SZ", "000001.SH"):
            valuation = request(
                "index_dailybasic",
                {"ts_code": code, "trade_date": "20261105"},
                "ts_code,trade_date,pe_ttm,pb",
            )
            if valuation.get("code") != 0 or not valuation["data"]["items"]:
                raise EngineError("UPSTREAM_SCHEMA", "估值参考日请求失败")
            results["valuation_reference"][code] = dict(
                zip(valuation["data"]["fields"], valuation["data"]["items"][0], strict=True)
            )
        # 官方权限页：kpl_list 至少 5000 积分；只请求 1 行用于观察权限错误。
        permission = request("kpl_list", {"trade_date": "20261105", "limit": 1}, "ts_code")
        results["permission"] = {
            "api": "kpl_list",
            "code": permission.get("code"),
            "msg": redact(permission.get("msg", ""), token),
        }
        if include_rate_limit:
            # 仅实测工具执行一次有界负例；生产客户端始终使用 45 次/分钟限制。
            start = time.monotonic()
            results["rate_limit"] = {"observed": False, "requests": 0}
            for count in range(1, 52):
                body = request("stock_basic", {"list_status": "L", "limit": 1}, "ts_code")
                results["rate_limit"] = {
                    "observed": body.get("code") != 0,
                    "requests": count,
                    "code": body.get("code"),
                    "msg": redact(body.get("msg", ""), token),
                    "elapsed_seconds": time.monotonic() - start,
                }
                if body.get("code") != 0:
                    break
            # 释放本次负例占用的分钟配额，再开始正式回补。
            time.sleep(65)
    return results


def report(path: Path) -> dict:
    db = Database(path)
    try:
        values = [
            row[0]
            for row in db.conn.execute(
                "SELECT value FROM indicator_values WHERE series_key='new_high_60d_share' "
                "AND value IS NOT NULL"
            )
        ]
        result = db.status()
        result["new_high_distribution"] = (
            dict(
                zip(("P5", "P50", "P95"), np.percentile(values, [5, 50, 95]).tolist(), strict=True)
            )
            if values
            else None
        )
        result["stock_daily_rows"] = db.conn.execute("SELECT count(*) FROM stock_daily").fetchone()[
            0
        ]
        result["valuation_coverage"] = [
            dict(row)
            for row in db.conn.execute(
                "SELECT ts_code,MIN(trade_date) AS first_date,MAX(trade_date) AS last_date,"
                "COUNT(*) AS rows FROM index_valuation GROUP BY ts_code"
            )
        ]
        # 用单独的日 SQL + 排序手算三个交易日，避免只对同一个函数自证。
        checks = []
        candidates = [
            row[0]
            for row in db.conn.execute(
                "SELECT trade_date FROM indicator_values WHERE series_key='new_high_60d_share' "
                "AND value IS NOT NULL ORDER BY trade_date"
            )
        ]
        selected = (
            [candidates[index] for index in (0, len(candidates) // 2, len(candidates) - 1)]
            if candidates
            else []
        )
        for day in selected:
            window = [
                row[0]
                for row in db.conn.execute(
                    "SELECT cal_date FROM trade_calendar WHERE is_open=1 AND cal_date<=? "
                    "ORDER BY cal_date DESC LIMIT 60",
                    (day,),
                )
            ]
            rows = db.conn.execute(
                "SELECT d.sid,d.trade_date,d.close*d.adj_factor AS price,s.list_date "
                "FROM stock_daily d JOIN securities s USING(sid) "
                "WHERE d.trade_date BETWEEN ? AND ? AND d.amount>0 "
                "AND (s.ts_code LIKE '%.SH' OR s.ts_code LIKE '%.SZ')",
                (min(window), day),
            ).fetchall()
            stocks = {}
            for row in rows:
                stocks.setdefault(row["sid"], []).append(row)
            eligible = [
                items
                for items in stocks.values()
                if len(items) >= 45
                and items[0]["list_date"] <= min(window)
                and any(row["trade_date"] == day for row in items)
            ]
            highs = sum(
                next(row["price"] for row in items if row["trade_date"] == day)
                >= max(row["price"] for row in items)
                for items in eligible
            )
            actual = db.conn.execute(
                "SELECT value FROM indicator_values WHERE series_key="
                "'new_high_60d_share' AND trade_date=?",
                (day,),
            ).fetchone()[0]
            checks.append(
                {
                    "trade_date": day,
                    "n": len(eligible),
                    "new_high": highs,
                    "manual": highs / len(eligible) * 100,
                    "stored": actual,
                }
            )
        result["manual_new_high_checks"] = checks
        return result
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="F1 联网实测（不修改用户的 workbench.db）")
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--probe-only", action="store_true")
    parser.add_argument("--probe-rate-limit", action="store_true")
    args = parser.parse_args()
    path = args.db.resolve()
    token = os.environ.pop("TUSHARE_TOKEN", "")
    if not token:
        raise SystemExit("请先设置本机 TUSHARE_TOKEN，不要把 token 放在参数或对话里")
    protocol = Protocol(token=token)
    measured = probes(token, args.probe_rate_limit)
    db = Database(path)
    try:
        with db.conn:
            db.conn.execute(
                "INSERT INTO run_log VALUES (?,?,?,?,?,?,?,?)",
                (
                    str(uuid.uuid4()),
                    timestamp(),
                    timestamp(),
                    "probe",
                    "ok",
                    None,
                    None,
                    redact(json.dumps(measured, ensure_ascii=False), token),
                ),
            )
    finally:
        db.close()
    protocol.emit("measurement", **measured)
    if args.probe_only:
        return 0
    client = TushareClient(token)
    try:
        result = update(path, client, protocol, datetime.now(SHANGHAI))
    finally:
        client.close()
    protocol.emit("measurement", **report(path))
    return result


if __name__ == "__main__":
    raise SystemExit(main())
