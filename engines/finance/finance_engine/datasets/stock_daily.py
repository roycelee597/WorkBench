"""日线和因子按同一交易日事务提交；失败不留下半天数据。"""

import logging
import math
import sqlite3
from collections.abc import Callable
from datetime import datetime

from ..db import Database, timestamp
from ..errors import EngineError, redact
from ..planner import SHANGHAI
from ..sources.tushare import TushareClient
from . import adj_factor
from .security_codes import canonical_code, historical_code

logger = logging.getLogger(__name__)
FIELDS = ["ts_code", "trade_date", "close", "amount"]
# 旧版按运行次数计数，不能沿用其 attempts 或停止补取标记。
CATALOG_GAP = "证券目录按日重试仍未收录"
CATALOG_MISSING_LIMIT = 3


def _catalog_gap(db: Database, day: int) -> sqlite3.Row | None:
    return db.conn.execute(
        "SELECT status,attempts,fetched_at FROM dataset_status "
        "WHERE dataset='stock_daily' AND trade_date=? AND last_error LIKE ?",
        (day, CATALOG_GAP + "%"),
    ).fetchone()


def _missing_attempts(previous: sqlite3.Row | None, fetched_at: int) -> int:
    if previous is None:
        return 1
    previous_day = datetime.fromtimestamp(previous["fetched_at"] / 1000, SHANGHAI).date()
    current_day = datetime.fromtimestamp(fetched_at / 1000, SHANGHAI).date()
    return previous["attempts"] + int(current_day != previous_day)


def exhausted_days(db: Database) -> set[int]:
    return {
        row[0]
        for row in db.conn.execute(
            "SELECT trade_date FROM dataset_status "
            "WHERE dataset='stock_daily' AND status='error' AND last_error LIKE ?",
            (CATALOG_GAP + "%",),
        )
    }


def mark_fetch_failure(db: Database, day: int, status: str, error: str) -> None:
    with db.conn:
        # 请求失败或空响应无法核对目录，保留上次有效响应确认的缺码次数。
        if _catalog_gap(db, day) is None:
            db.mark("stock_daily", day, status, error=error)


def fetch(client: TushareClient, day: int, codes: list[str] | None = None) -> list[dict]:
    return client.fetch("daily", {"trade_date": str(day)}, FIELDS, fallback_codes=codes)


def refresh(
    db: Database,
    client: TushareClient,
    day: int,
    today: int,
    *,
    warn: Callable[[EngineError], None] | None = None,
    now: datetime | None = None,
) -> bool:
    catalog_gap = _catalog_gap(db, day)
    if catalog_gap is not None and catalog_gap["status"] == "error":
        return False
    securities = {row["ts_code"]: row for row in db.conn.execute("SELECT * FROM securities")}
    codes = [
        historical_code(code, day)
        for code, row in securities.items()
        if (row["list_date"] or day) <= day
        and (row["delist_date"] is None or row["delist_date"] >= day)
    ]
    daily = fetch(client, day, codes)
    unknown_bj = {
        row["ts_code"]
        for row in daily
        if row["ts_code"].endswith(".BJ") and row["ts_code"] not in securities
    }
    if unknown_bj:
        if warn is not None:
            examples = "、".join(sorted(unknown_bj)[:5])
            warn(
                EngineError(
                    "UNKNOWN_BJ_CODE",
                    f"{day} 跳过证券目录未收录的 {len(unknown_bj)} 个北交所代码（{examples}）",
                )
            )
        daily = [row for row in daily if row["ts_code"] not in unknown_bj]
    if not daily:
        mark_fetch_failure(db, day, "pending", "日线尚未发布")
        return False
    if any(int(row["trade_date"]) != day for row in daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线返回了请求日期之外的数据")
    if len({row["ts_code"] for row in daily}) != len(daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线分页出现重复证券，拒绝不完整数据")
    if warn is not None:
        by_quote: dict[tuple[float, float], dict[str, str]] = {}
        for row in daily:
            amount = float(row["amount"])
            if amount <= 0:
                continue
            code = row["ts_code"]
            quote = (float(row["close"]), amount)
            by_quote.setdefault(quote, {}).setdefault(canonical_code(code, day), code)
        matches = []
        bj_matches = []
        for group in by_quote.values():
            if len(group) < 2:
                continue
            group_codes = sorted(group.values())
            mainland = [code for code in group_codes if not code.endswith(".BJ")]
            if len(mainland) > 1:
                matches.append(mainland)
            if len(mainland) < len(group_codes):
                bj_matches.append(group_codes)
        if bj_matches:
            examples = "、".join(" / ".join(group[:4]) for group in bj_matches[:5])
            logger.warning(
                "%s",
                redact(
                    f"{day} 有 {len(bj_matches)} 组涉及北交所的疑似代码变更（示例：{examples}）",
                    client.token,
                ),
            )
        if matches:
            examples = "、".join(" / ".join(group[:4]) for group in matches[:5])
            warn(
                EngineError(
                    "POSSIBLE_CODE_CHANGE",
                    f"{day} 有 {len(matches)} 组不同证券收盘价和成交额完全相同，"
                    f"可能有未登记的代码变更（示例：{examples}），请核对正式公告",
                )
            )
    unknown = sorted(
        row["ts_code"] for row in daily if canonical_code(row["ts_code"], day) not in securities
    )
    if unknown:
        examples = "、".join(unknown[:5])
        fetched_at = int(now.timestamp() * 1000) if now is not None else timestamp()
        attempts = _missing_attempts(catalog_gap, fetched_at)
        limit_reached = attempts >= CATALOG_MISSING_LIMIT
        next_step = "已停止自动补取" if limit_reached else "等待刷新目录"
        with db.conn:
            db.mark(
                "stock_daily",
                day,
                "error" if limit_reached else "pending",
                error=redact(
                    f"{CATALOG_GAP} {len(unknown)} 个代码（{examples}），{next_step}",
                    client.token,
                ),
                attempts=attempts,
                fetched_at=fetched_at,
            )
        return False
    identities = {canonical_code(row["ts_code"], day) for row in daily}
    active_daily = [
        row
        for row in daily
        if row["ts_code"] == historical_code(canonical_code(row["ts_code"], day), day)
    ]
    if identities != {canonical_code(row["ts_code"], day) for row in active_daily}:
        raise EngineError("UPSTREAM_SCHEMA", f"{day} 缺少当日正式有效代码的数据，拒绝替代")
    factor_state = db.conn.execute(
        "SELECT attempts,last_error,fetched_at FROM dataset_status "
        "WHERE dataset='adj_factor' AND trade_date=?",
        (day,),
    ).fetchone()
    exhausted = factor_state is not None and factor_state["last_error"] == adj_factor.EXHAUSTED
    previous_factor_gap = (
        factor_state
        if factor_state is not None and factor_state["last_error"] == adj_factor.MISSING
        else None
    )
    factor_error = None
    factors = []
    if not exhausted:
        try:
            factors = adj_factor.fetch(client, day, codes)
        except EngineError as error:
            if not error.retryable:
                raise
            factor_error = error
    factor_map = {row["ts_code"]: row["adj_factor"] for row in factors}
    if any(int(row["trade_date"]) != day for row in factors) or len(factor_map) != len(factors):
        raise EngineError("UPSTREAM_SCHEMA", "复权因子日期或分页唯一性校验失败")
    cached_factors = (
        dict(db.conn.execute("SELECT sid,adj_factor FROM stock_daily WHERE trade_date=?", (day,)))
        if exhausted or factor_error
        else {}
    )
    records_by_sid = {}
    missing = False
    for row in active_daily:
        close, amount = float(row["close"]), float(row["amount"])
        if not math.isfinite(close) or not math.isfinite(amount):
            raise EngineError("UPSTREAM_SCHEMA", "日线包含无效数值")
        sid = securities[canonical_code(row["ts_code"], day)]["sid"]
        factor = (
            cached_factors.get(sid) if exhausted or factor_error else factor_map.get(row["ts_code"])
        )
        factor = float(factor) if factor is not None else None
        if factor is not None and (not math.isfinite(factor) or factor <= 0):
            factor = None
        if amount > 0 and row["ts_code"].endswith((".SH", ".SZ")) and factor is None:
            missing = True
        record = (day, sid, close, amount, factor, "tushare")
        previous = records_by_sid.get(sid)
        if previous is not None and previous != record:
            raise EngineError("UPSTREAM_SCHEMA", f"{day} 历史代码别名数据冲突，拒绝合并")
        # Royce 已确认只取当日正式有效代码，未生效/失效代码的回写不参与计算。
        records_by_sid[sid] = record
    records = list(records_by_sid.values())
    with db.conn:
        # 删除的只是该日可重建缓存；与新行、完成标记一起提交或回滚。
        db.conn.execute("DELETE FROM stock_daily WHERE trade_date=?", (day,))
        db.conn.executemany("INSERT INTO stock_daily VALUES (?,?,?,?,?,?)", records)
        db.mark("stock_daily", day, "ok", len(records))
        if not exhausted:
            if factor_error:
                # 请求失败不计入成功取数后发现缺失的次数。
                if previous_factor_gap is None:
                    db.mark("adj_factor", day, "pending", error=redact(factor_error, client.token))
            elif missing:
                fetched_at = int(now.timestamp() * 1000) if now is not None else timestamp()
                attempts = _missing_attempts(previous_factor_gap, fetched_at)
                limit_reached = attempts >= adj_factor.MISSING_LIMIT
                db.mark(
                    "adj_factor",
                    day,
                    "error" if limit_reached else "pending",
                    len(factors),
                    adj_factor.EXHAUSTED if limit_reached else adj_factor.MISSING,
                    attempts=attempts,
                    fetched_at=fetched_at,
                )
            else:
                db.mark("adj_factor", day, "ok", len(factors))
    return not (missing or exhausted or factor_error)
