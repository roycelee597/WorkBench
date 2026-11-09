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
        if body["api_name"] == "index_dailybasic":
            return response(
                body["fields"].split(","),
                [
                    {
                        "ts_code": body["params"]["ts_code"],
                        "trade_date": "20261105",
                        "pe_ttm": 13.5949,
                        "pb": 1.34,
                    }
                ],
            )
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
    assert result["top5_reference"]["n"] == 0
    assert result["valuation_reference"]["000300.SH"]["pe_ttm"] == 13.5949
    assert TOKEN not in str(result)


@respx.mock
def test_rate_probe_varies_offsets_and_does_not_misclassify_permissions(monkeypatch):
    tools = runpy.run_path(str(Path(__file__).parents[1] / "scripts" / "live_validation.py"))
    offsets = []
    waits = []
    monkeypatch.setattr(tools["probes"].__globals__["time"], "sleep", waits.append)

    def handler(request):
        body = request_body(request)
        if body["api_name"] == "stock_basic":
            offsets.append(body["params"]["offset"])
            if len(offsets) == 51:
                return httpx.Response(200, json={"code": -1, "msg": "每分钟最多访问50次"})
            return response(["ts_code"], [{"ts_code": "000001.SZ"}])
        if body["api_name"] == "kpl_list":
            return httpx.Response(200, json={"code": 40203, "msg": "无权限"})
        if body["api_name"] == "index_dailybasic":
            return response(
                body["fields"].split(","),
                [
                    {
                        "ts_code": body["params"]["ts_code"],
                        "trade_date": "20261105",
                        "pe_ttm": 13.5949,
                        "pb": 1.3393,
                    }
                ],
            )
        rows = [{"ts_code": str(i), "trade_date": "20261105", "amount": i} for i in range(9)]
        params = body["params"]
        return response(
            body["fields"].split(","), rows[params["offset"] : params["offset"] + params["limit"]]
        )

    route = respx.post(URL).mock(side_effect=handler)
    result = tools["probes"](TOKEN, True)
    assert offsets == list(range(51))
    assert result["rate_limit"]["observed"] and result["rate_limit"]["requests"] == 51
    assert waits == [65]
    # 其他错误不能伪装成已观察到限流。
    route.mock(
        side_effect=lambda request: (
            httpx.Response(200, json={"code": 40203, "msg": "无权限"})
            if request_body(request)["api_name"] == "stock_basic"
            else handler(request)
        )
    )
    assert not tools["probes"](TOKEN, True)["rate_limit"]["observed"]
