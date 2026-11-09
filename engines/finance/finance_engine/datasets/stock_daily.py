"""日线和因子按同一交易日事务提交；失败不留下半天数据。"""

import math
from collections.abc import Callable

from ..db import Database
from ..errors import EngineError, redact
from ..sources.tushare import TushareClient
from . import adj_factor
from .security_codes import canonical_code, historical_code

FIELDS = ["ts_code", "trade_date", "close", "amount"]


def fetch(client: TushareClient, day: int, codes: list[str] | None = None) -> list[dict]:
    return client.fetch("daily", {"trade_date": str(day)}, FIELDS, fallback_codes=codes)


def refresh(
    db: Database,
    client: TushareClient,
    day: int,
    today: int,
    *,
    warn: Callable[[EngineError], None] | None = None,
) -> bool:
    securities = {row["ts_code"]: row for row in db.conn.execute("SELECT * FROM securities")}
    codes = [
        historical_code(code, day)
        for code, row in securities.items()
        if (row["list_date"] or day) <= day
        and (row["delist_date"] is None or row["delist_date"] >= day)
    ]
    daily = fetch(client, day, codes)
    if not daily:
        with db.conn:
            db.mark("stock_daily", day, "pending", error="日线尚未发布")
        return False
    if any(int(row["trade_date"]) != day for row in daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线返回了请求日期之外的数据")
    if len({row["ts_code"] for row in daily}) != len(daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线分页出现重复证券，拒绝不完整数据")
    if warn is not None:
        by_quote: dict[tuple[float, float], dict[str, str]] = {}
        for row in daily:
            code = row["ts_code"]
            quote = (float(row["close"]), float(row["amount"]))
            by_quote.setdefault(quote, {}).setdefault(canonical_code(code, day), code)
        matches = [group for group in by_quote.values() if len(group) > 1]
        if matches:
            examples = "、".join(" / ".join(sorted(group.values())[:4]) for group in matches[:5])
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
        with db.conn:
            db.mark(
                "stock_daily",
                day,
                "pending",
                error=redact(
                    f"证券目录未收录 {len(unknown)} 个代码（{examples}），等待刷新目录",
                    client.token,
                ),
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
        "SELECT attempts,last_error FROM dataset_status "
        "WHERE dataset='adj_factor' AND trade_date=?",
        (day,),
    ).fetchone()
    exhausted = factor_state is not None and factor_state["last_error"] == adj_factor.EXHAUSTED
    missing_attempts = (
        factor_state["attempts"]
        if factor_state is not None and factor_state["last_error"] == adj_factor.MISSING
        else 0
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
                if not missing_attempts:
                    db.mark("adj_factor", day, "pending", error=redact(factor_error, client.token))
            elif missing:
                attempts = missing_attempts + 1
                limit_reached = attempts >= adj_factor.MISSING_LIMIT
                db.mark(
                    "adj_factor",
                    day,
                    "error" if limit_reached else "pending",
                    len(factors),
                    adj_factor.EXHAUSTED if limit_reached else adj_factor.MISSING,
                    attempts=attempts,
                )
            else:
                db.mark("adj_factor", day, "ok", len(factors))
    return not (missing or exhausted or factor_error)
