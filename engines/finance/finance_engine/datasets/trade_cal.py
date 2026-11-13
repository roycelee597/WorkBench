"""交易日历覆盖 2005 年至当年年底。"""

from ..db import Database
from ..sources.tushare import TushareClient

FIELDS = ["cal_date", "is_open"]


def fetch(client: TushareClient, year: int) -> list[dict]:
    rows = client.fetch(
        "trade_cal",
        {"exchange": "SSE", "start_date": "20050101", "end_date": f"{year}1231"},
        FIELDS,
        limit=120000,
    )
    return [{**row, "source": "tushare"} for row in rows]


def store(db: Database, rows: list[dict]) -> None:
    with db.conn:
        db.conn.executemany(
            "INSERT INTO trade_calendar VALUES (?,?) ON CONFLICT(cal_date) "
            "DO UPDATE SET is_open=excluded.is_open",
            [(int(row["cal_date"]), int(row["is_open"])) for row in rows],
        )
        for row in rows:
            # 日历表维持原结构，在已有状态表按日期保存来源，不需要改缓存版本。
            db.mark("trade_cal", int(row["cal_date"]), "ok", 1, source=row.get("source", "tushare"))
