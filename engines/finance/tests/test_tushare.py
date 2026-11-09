"""真实 HTTP 边界由 respx 拦截，CI 不访问 Tushare。"""

import httpx
import pytest
import respx

from finance_engine.errors import EngineError
from finance_engine.sources.tushare import URL

from .conftest import TOKEN, request_body, response


@respx.mock
def test_fields_and_6000_pagination(client):
    fields = ["ts_code", "amount"]
    offsets = []

    def handler(request):
        body = request_body(request)
        offset = body["params"]["offset"]
        offsets.append(offset)
        assert body["token"] == TOKEN
        assert body["fields"] == "ts_code,amount"
        count = 6000 if offset == 0 else 2
        # 返回字段顺序和请求不同也必须正确映射。
        return response(
            list(reversed(fields)),
            [{"ts_code": str(i), "amount": i} for i in range(offset, offset + count)],
        )

    respx.post(URL).mock(side_effect=handler)
    rows = client.fetch("daily", {}, fields)
    assert offsets == [0, 6000]
    assert len(rows) == 6002 and rows[-1] == {"amount": 6001, "ts_code": "6001"}


@respx.mock
def test_has_more_and_ignored_offset_fail_closed(client):
    route = respx.post(URL).mock(
        side_effect=[response(["x"], [{"x": 1}], has_more=True), response(["x"], [{"x": 2}])]
    )
    assert client.fetch("daily", {}, ["x"]) == [{"x": 1}, {"x": 2}]
    route.mock(return_value=response(["x"], [{"x": 1}], has_more=True))
    with pytest.raises(EngineError, match="分页未前进"):
        client.fetch("daily", {}, ["x"])


@respx.mock
def test_pagination_falls_back_to_each_security(client):
    def handler(request):
        params = request_body(request)["params"]
        if "ts_code" in params:
            return response(["ts_code"], [{"ts_code": params["ts_code"]}])
        return response(["ts_code"], [{"ts_code": "a"}, {"ts_code": "b"}])

    respx.post(URL).mock(side_effect=handler)
    assert client.fetch("daily", {}, ["ts_code"], limit=2, fallback_codes=["a", "b"]) == [
        {"ts_code": "a"},
        {"ts_code": "b"},
    ]


@pytest.mark.parametrize(
    ("code", "message", "expected"),
    [
        (40101, "token 无效", "TOKEN_INVALID"),
        (-2002, "积分不足，您没有权限", "PERMISSION_DENIED"),
        (40203, "接口拒绝访问", "PERMISSION_DENIED"),
        (-2002, "每分钟最多访问200次", "RATE_LIMITED"),
        (999, "格式变化", "UPSTREAM_SCHEMA"),
    ],
)
@respx.mock
def test_errors_are_classified_and_redacted(client, code, message, expected):
    respx.post(URL).mock(
        return_value=httpx.Response(200, json={"code": code, "msg": message + TOKEN})
    )
    with pytest.raises(EngineError) as error:
        client.fetch("daily", {}, ["x"])
    assert error.value.code == expected
    assert TOKEN not in str(error.value)
    assert TOKEN not in str(client.errors)
    assert client.errors[0]["code"] == code


@respx.mock
def test_retries_backoff_and_rate_limit(client, clock):
    respx.post(URL).mock(side_effect=httpx.ReadTimeout("hidden " + TOKEN))
    with pytest.raises(EngineError) as error:
        client.fetch("daily", {}, ["x"])
    assert error.value.code == "NETWORK"
    assert [wait for wait in clock.waits if wait >= 2] == [2, 8, 30]
    respx.post(URL).mock(
        return_value=httpx.Response(200, json={"code": -2, "msg": "每分钟最多访问"})
    )
    with pytest.raises(EngineError):
        client.fetch("daily", {}, ["x"])
    assert clock.waits.count(60) == 3


@respx.mock
def test_schema_and_5xx(client):
    route = respx.post(URL).mock(return_value=response(["wrong"], []))
    with pytest.raises(EngineError) as error:
        client.fetch("daily", {}, ["expected"])
    assert error.value.code == "UPSTREAM_SCHEMA"
    route.mock(side_effect=[httpx.Response(503), response(["x"], [{"x": 2}])])
    assert client.fetch("daily", {}, ["x"]) == [{"x": 2}]


@respx.mock
def test_aggregate_and_stock_basic_limits(client, clock):
    respx.post(URL).mock(return_value=response(["x"], []))
    for _ in range(181):
        client.request("daily", {}, ["x"])
    assert clock.value >= 60 - 1e-6
    start = clock.value
    for _ in range(46):
        client.request("stock_basic", {}, ["x"])
    assert clock.value - start >= 60 - 1e-6
