"""复权因子按交易日独立取数。"""

from ..db import Database
from ..sources.tushare import TushareClient

FIELDS = ["ts_code", "trade_date", "adj_factor"]
MISSING_LIMIT = 3
# 旧版按运行次数写入的状态不能推断缺失天数，改用新的标记重新计数。
MISSING = "复权因子按日重试仍缺失，等待下次取数"
EXHAUSTED = "复权因子在三个不同自然日缺失，已停止自动补取"


def exhausted_days(db: Database) -> set[int]:
    return {
        row[0]
        for row in db.conn.execute(
            "SELECT trade_date FROM dataset_status WHERE dataset='adj_factor' AND last_error=?",
            (EXHAUSTED,),
        )
    }


def fetch(client: TushareClient, day: int, codes: list[str]) -> list[dict]:
    return client.fetch("adj_factor", {"trade_date": str(day)}, FIELDS, fallback_codes=codes)
