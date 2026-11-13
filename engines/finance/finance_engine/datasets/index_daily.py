"""沪深300 叠加线，按区间拉取并逐日提交。"""

from ..db import Database
from ..errors import EngineError
from ..sources.akshare_fallback import AkshareFallback
from ..sources.tushare import TushareClient

FIELDS = ["ts_code", "trade_date", "close"]


def refresh(
    db: Database,
    client: TushareClient,
    dates: list[int],
    today: int,
    *,
    fallback: AkshareFallback | None = None,
) -> bool:
    if not dates:
        return True
    try:
        rows = client.fetch(
            "index_daily",
            {"ts_code": "000300.SH", "start_date": str(min(dates)), "end_date": str(max(dates))},
            FIELDS,
            limit=10000,
        )
        rows = [{**row, "source": "tushare"} for row in rows]
    except EngineError as error:
        if error.code == "CANCELLED" or fallback is None:
            raise
        rows = fallback.index(dates)
        if rows is None:
            raise
        fallback.warn(error)
    return store(db, rows, dates)


def store(db: Database, rows: list[dict], dates: list[int]) -> bool:
    if not dates:
        return True
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
            source = row.get("source", "tushare") if row else "tushare"
            cached = db.conn.execute(
                "SELECT source FROM index_daily WHERE ts_code='000300.SH' AND trade_date=?", (day,)
            ).fetchone()
            if source == "akshare" and cached and cached[0] == "tushare":
                continue
            if row:
                db.conn.execute(
                    "INSERT OR REPLACE INTO index_daily VALUES (?,?,?,?)",
                    ("000300.SH", day, float(row["close"]), source),
                )
            db.mark(
                "index_daily.000300.SH",
                day,
                "ok" if row else "pending",
                int(bool(row)),
                source=source,
            )
        complete &= row is not None
    return complete
