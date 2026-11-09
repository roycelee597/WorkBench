"""沪深300 叠加线，按区间拉取并逐日提交。"""

from ..db import Database
from ..errors import EngineError
from ..sources.tushare import TushareClient

FIELDS = ["ts_code", "trade_date", "close"]


def refresh(db: Database, client: TushareClient, dates: list[int], today: int) -> bool:
    if not dates:
        return True
    rows = client.fetch(
        "index_daily",
        {"ts_code": "000300.SH", "start_date": str(min(dates)), "end_date": str(max(dates))},
        FIELDS,
        limit=10000,
    )
    mapped = {int(row["trade_date"]): row for row in rows}
    if len(mapped) != len(rows) or any(
        row["ts_code"] != "000300.SH" or not min(dates) <= int(row["trade_date"]) <= max(dates)
        for row in rows
    ):
        raise EngineError("UPSTREAM_SCHEMA", "指数日线代码、日期或分页唯一性校验失败")
    complete = True
    for day in dates:
        row = mapped.get(day)
        with db.conn:
            if row:
                db.conn.execute(
                    "INSERT OR REPLACE INTO index_daily VALUES (?,?,?,?)",
                    ("000300.SH", day, float(row["close"]), "tushare"),
                )
            db.mark("index_daily.000300.SH", day, "ok" if row else "pending", int(bool(row)))
        complete &= row is not None
    return complete
