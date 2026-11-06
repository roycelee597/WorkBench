"""交易日历覆盖 2005 年至当年年底。"""

from ..db import Database
from ..sources.tushare import TushareClient

FIELDS = ["cal_date", "is_open"]


def fetch(client: TushareClient, year: int) -> list[dict]:
    return client.fetch(
        "trade_cal",
        {"exchange": "SSE", "start_date": "20050101", "end_date": f"{year}1231"},
        FIELDS,
        limit=120000,
    )


def store(db: Database, rows: list[dict]) -> None:
    with db.conn:
        db.conn.executemany(
            "INSERT INTO trade_calendar VALUES (?,?) ON CONFLICT(cal_date) "
            "DO UPDATE SET is_open=excluded.is_open",
            [(int(row["cal_date"]), int(row["is_open"])) for row in rows],
        )
