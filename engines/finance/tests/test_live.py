"""只从环境读取凭据；默认不运行，不向断言、日志传入真实 token。"""

import os

import pytest

from finance_engine.datasets import stock_daily
from finance_engine.indicators.top5_turnover import top5_turnover
from finance_engine.sources.tushare import TushareClient


@pytest.mark.live
def test_20261105_reference():
    token = os.environ.get("TUSHARE_TOKEN")
    if not token:
        pytest.skip("需要在本机设置 TUSHARE_TOKEN；请勿将密钥发送到对话")
    client = TushareClient(token)
    try:
        rows = stock_daily.fetch(client, 20261105)
        point = top5_turnover(20261105, rows)
        assert point.extra == {"n": 5217, "k": 261}
        assert abs(point.value - 44.2) < 0.05
        rows = client.fetch(
            "index_dailybasic",
            {"ts_code": "000300.SH", "trade_date": "20261105"},
            ["ts_code", "trade_date", "pe_ttm", "pb"],
            limit=3000,
        )
        assert float(rows[0]["pe_ttm"]) == pytest.approx(13.59)
        assert float(rows[0]["pb"]) == pytest.approx(1.34)
    finally:
        client.close()
