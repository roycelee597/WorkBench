"""三个指数独立跟踪完成情况，缺少一个指数不妨碍另两个。"""

from ..db import Database
from ..errors import EngineError
from ..sources.tushare import TushareClient

FIELDS = ["ts_code", "trade_date", "pe", "pe_ttm", "pb"]


def refresh(db: Database, client: TushareClient, code: str, dates: list[int], today: int) -> bool:
    if not dates:
        return True
    rows = client.fetch(
        "index_dailybasic",
        {"ts_code": code, "start_date": str(min(dates)), "end_date": str(max(dates))},
        FIELDS,
        limit=3000,
    )
    mapped = {int(row["trade_date"]): row for row in rows}
    if len(mapped) != len(rows) or any(
        row["ts_code"] != code or not min(dates) <= int(row["trade_date"]) <= max(dates)
        for row in rows
    ):
        raise EngineError("UPSTREAM_SCHEMA", "估值代码、日期或分页唯一性校验失败")
    first = min(mapped) if mapped else None
    known = db.conn.execute(
        "SELECT MIN(trade_date) FROM index_valuation WHERE ts_code=?", (code,)
    ).fetchone()[0]
    if known:
        first = min(first, known) if first else known
    complete = True
    for day in dates:
        row = mapped.get(day)
        # 历史起点之前确无数据记 empty；今天或历史中间缺口保持 pending。
        status = "ok" if row else ("empty" if first and day < first and day < today else "pending")
        with db.conn:
            if row:
                db.conn.execute(
                    "INSERT OR REPLACE INTO index_valuation VALUES (?,?,?,?,?,?)",
                    (code, day, row["pe"], row["pe_ttm"], row["pb"], "tushare"),
                )
            db.mark("index_valuation." + code, day, status, int(bool(row)))
        complete &= status != "pending"
    return complete
