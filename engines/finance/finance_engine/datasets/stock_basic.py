"""包括已退市和暂停上市证券，避免幸存者偏差。"""

from ..db import Database, timestamp
from ..sources.tushare import TushareClient

FIELDS = ["ts_code", "name", "exchange", "market", "list_date", "delist_date", "list_status"]


def refresh(db: Database, client: TushareClient) -> None:
    for status in ("L", "D", "P"):
        rows = client.fetch("stock_basic", {"list_status": status}, FIELDS)
        with db.conn:
            db.conn.executemany(
                """INSERT INTO securities
                (ts_code,name,exchange,market,list_date,delist_date,list_status,updated_at)
                VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(ts_code) DO UPDATE SET
                name=excluded.name,exchange=excluded.exchange,market=excluded.market,
                list_date=excluded.list_date,delist_date=excluded.delist_date,
                list_status=excluded.list_status,updated_at=excluded.updated_at""",
                [
                    (
                        row["ts_code"],
                        row["name"],
                        row["exchange"],
                        row["market"],
                        int(row["list_date"]) if row["list_date"] else None,
                        int(row["delist_date"]) if row["delist_date"] else None,
                        row["list_status"],
                        timestamp(),
                    )
                    for row in rows
                ],
            )
