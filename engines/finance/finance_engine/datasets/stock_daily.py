"""日线和因子按同一交易日事务提交；失败不留下半天数据。"""

import math

from ..db import Database
from ..errors import EngineError, redact
from ..sources.tushare import TushareClient
from . import adj_factor
from .security_codes import canonical_code, historical_code

FIELDS = ["ts_code", "trade_date", "close", "amount"]


def fetch(client: TushareClient, day: int, codes: list[str] | None = None) -> list[dict]:
    return client.fetch("daily", {"trade_date": str(day)}, FIELDS, fallback_codes=codes)


def refresh(db: Database, client: TushareClient, day: int, today: int) -> bool:
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
    factor_error = None
    try:
        factors = adj_factor.fetch(client, day, codes)
    except EngineError as error:
        if error.code in ("TOKEN_INVALID", "PERMISSION_DENIED", "UPSTREAM_SCHEMA"):
            raise
        factor_error = error
        factors = []
    factor_map = {row["ts_code"]: row["adj_factor"] for row in factors}
    if any(int(row["trade_date"]) != day for row in factors) or len(factor_map) != len(factors):
        raise EngineError("UPSTREAM_SCHEMA", "复权因子日期或分页唯一性校验失败")
    if any(int(row["trade_date"]) != day for row in daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线返回了请求日期之外的数据")
    if any(canonical_code(row["ts_code"], day) not in securities for row in daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线出现证券目录未收录的代码，等待下次刷新目录")
    if len({row["ts_code"] for row in daily}) != len(daily):
        raise EngineError("UPSTREAM_SCHEMA", "日线分页出现重复证券，拒绝不完整数据")
    identities = {canonical_code(row["ts_code"], day) for row in daily}
    active_daily = [
        row
        for row in daily
        if row["ts_code"] == historical_code(canonical_code(row["ts_code"], day), day)
    ]
    if identities != {canonical_code(row["ts_code"], day) for row in active_daily}:
        raise EngineError("UPSTREAM_SCHEMA", f"{day} 缺少当日正式有效代码的数据，拒绝替代")
    records_by_sid = {}
    missing = False
    for row in active_daily:
        close, amount = float(row["close"]), float(row["amount"])
        if not math.isfinite(close) or not math.isfinite(amount):
            raise EngineError("UPSTREAM_SCHEMA", "日线包含无效数值")
        factor = factor_map.get(row["ts_code"])
        factor = float(factor) if factor is not None else None
        if factor is not None and (not math.isfinite(factor) or factor <= 0):
            factor = None
        if amount > 0 and row["ts_code"].endswith((".SH", ".SZ")) and factor is None:
            missing = True
        sid = securities[canonical_code(row["ts_code"], day)]["sid"]
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
        db.mark(
            "adj_factor",
            day,
            "pending" if missing else "ok",
            len(factors),
            redact(factor_error, client.token)
            if factor_error
            else ("部分复权因子缺失" if missing else None),
        )
    return not missing
