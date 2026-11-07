"""Tushare 官方 HTTP 客户端，限速、分页、重试与错误映射。"""

import time
from collections import Counter
from collections.abc import Callable

import httpx

from ..errors import EngineError, redact
from ..ratelimit import TokenBucket

URL = "https://api.tushare.pro"


class TushareClient:
    def __init__(
        self,
        token: str,
        *,
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
    ):
        self.token = token
        self.http = http or httpx.Client(timeout=30, follow_redirects=False)
        self.sleep = sleep
        self.global_bucket = TokenBucket(180, now=now, sleep=sleep)
        self.stock_bucket = TokenBucket(45, now=now, sleep=sleep)
        self.calls: Counter[str] = Counter()
        self.errors: list[dict] = []

    def close(self) -> None:
        self.http.close()

    def request(self, api: str, params: dict, fields: list[str]) -> tuple[list[dict], bool]:
        for attempt in range(4):
            if api == "stock_basic":
                self.stock_bucket.acquire()
            self.global_bucket.acquire()
            self.calls[api + ":" + str(params.get("ts_code", "all"))] += 1
            try:
                response = self.http.post(
                    URL,
                    json={
                        "api_name": api,
                        "token": self.token,
                        "params": params,
                        "fields": ",".join(fields),
                    },
                )
                if response.status_code == 429:
                    raise EngineError("RATE_LIMITED", "HTTP 请求被限流", retryable=True)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict):
                    raise ValueError("响应不是对象")
                if body.get("code") != 0:
                    code, message = body.get("code"), redact(body.get("msg", ""), self.token)
                    raw = {"api": api, "code": code, "msg": message}
                    self.errors.append(raw)
                    if str(code) == "40101":
                        raise EngineError("TOKEN_INVALID", "Tushare token 无效", upstream=raw)
                    if any(word in message for word in ("每分钟", "频次", "频率", "限流")):
                        raise EngineError("RATE_LIMITED", message, retryable=True, upstream=raw)
                    if str(code) == "40203" or any(
                        word in message for word in ("权限", "积分", "无权")
                    ):
                        raise EngineError(
                            "PERMISSION_DENIED",
                            f"{api} 权限不足（通常需要 2000 积分）：{message}",
                            upstream=raw,
                        )
                    raise EngineError(
                        "UPSTREAM_SCHEMA", f"{api} 上游返回错误：{message}", upstream=raw
                    )
                data = body.get("data")
                if not isinstance(data, dict):
                    raise ValueError("缺少 data")
                names, items = data.get("fields"), data.get("items")
                if not isinstance(names, list) or not isinstance(items, list):
                    raise ValueError("缺少 fields/items")
                if not set(fields).issubset(names):
                    raise ValueError("响应缺少所需字段")
                if any(not isinstance(row, list) or len(row) != len(names) for row in items):
                    raise ValueError("行字段数量不匹配")
                return [dict(zip(names, row, strict=True)) for row in items], bool(
                    data.get("has_more", body.get("has_more", False))
                )
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500:
                    raise EngineError(
                        "NETWORK", f"HTTP {error.response.status_code}", retryable=True
                    ) from None
                failure = EngineError("NETWORK", "Tushare 服务暂不可用", retryable=True)
            except httpx.RequestError:
                failure = EngineError("NETWORK", "网络不可用或请求超时", retryable=True)
            except (ValueError, TypeError) as error:
                raise EngineError(
                    "UPSTREAM_SCHEMA", f"{api} 数据格式变化：{redact(error, self.token)}"
                ) from None
            except EngineError as error:
                if not error.retryable:
                    raise
                failure = error
            if attempt == 3:
                raise failure
            self.sleep(60 if failure.code == "RATE_LIMITED" else (2, 8, 30)[attempt])
        raise AssertionError("不可达")

    def fetch(
        self,
        api: str,
        params: dict,
        fields: list[str],
        *,
        limit: int = 6000,
        fallback_codes: list[str] | None = None,
    ) -> list[dict]:
        rows: list[dict] = []
        seen_pages: set[tuple] = set()
        offset = 0
        while True:
            page, more = self.request(api, {**params, "limit": limit, "offset": offset}, fields)
            fingerprint = tuple(tuple(row.get(key) for key in fields) for row in page)
            if page and fingerprint in seen_pages:
                if fallback_codes:
                    # 不信任被忽略的 offset；退化为逐证券查询，宁可多请求也不静默截断。
                    return [
                        row
                        for code in fallback_codes
                        for row in self.fetch(api, {**params, "ts_code": code}, fields, limit=limit)
                    ]
                raise EngineError("UPSTREAM_SCHEMA", f"{api} 分页未前进，拒绝写入截断数据")
            seen_pages.add(fingerprint)
            rows.extend(page)
            if not more and len(page) < limit:
                return rows
            if not page:
                raise EngineError("UPSTREAM_SCHEMA", f"{api} has_more 与空分页矛盾")
            offset += len(page)
            if offset > 200_000:
                raise EngineError("UPSTREAM_SCHEMA", f"{api} 分页超过安全上限")
