"""实测探针也用模拟请求验证，测试时不占用用户配额。"""

import runpy
from pathlib import Path

import httpx
import respx

from finance_engine.sources.tushare import URL

from .conftest import TOKEN, request_body, response


@respx.mock
def test_probe_compares_real_page_slices_and_redacts_permission_response():
    tools = runpy.run_path(str(Path(__file__).parents[1] / "scripts" / "live_validation.py"))
    rows = [{"ts_code": str(i), "trade_date": "20261105", "amount": i} for i in range(9)]

    def handler(request):
        body = request_body(request)
        if body["api_name"] == "kpl_list":
            return httpx.Response(200, json={"code": -2002, "msg": "无权限 " + TOKEN})
        params = body["params"]
        offset, limit = params["offset"], params["limit"]
        return response(body["fields"].split(","), rows[offset : offset + limit])

    respx.post(URL).mock(side_effect=handler)
    result = tools["probes"](TOKEN, False)
    assert result["daily_pagination"] == {
        "limit_respected": True,
        "offset_matches_full": True,
        "full_rows": 9,
    }
    assert result["permission"]["code"] == -2002
    assert TOKEN not in str(result)
