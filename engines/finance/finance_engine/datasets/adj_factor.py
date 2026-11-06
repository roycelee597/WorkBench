"""复权因子按交易日独立取数。"""

from ..sources.tushare import TushareClient

FIELDS = ["ts_code", "trade_date", "adj_factor"]


def fetch(client: TushareClient, day: int, codes: list[str]) -> list[dict]:
    return client.fetch("adj_factor", {"trade_date": str(day)}, FIELDS, fallback_codes=codes)
