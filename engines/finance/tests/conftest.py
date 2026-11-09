"""无网络测试的时钟、HTTP 响应与临时数据库。"""

import json

import httpx
import pytest

from finance_engine.db import Database
from finance_engine.sources.tushare import TushareClient

TOKEN = "unit-test-only-secret"


class Clock:
    def __init__(self):
        self.value = 0.0
        self.waits = []

    def now(self):
        return self.value

    def sleep(self, delay):
        self.waits.append(delay)
        self.value += delay


def response(fields, rows, **extra):
    return httpx.Response(
        200,
        json={
            "code": 0,
            "data": {
                "fields": fields,
                "items": [[row.get(key) for key in fields] for row in rows],
                **extra,
            },
        },
    )


def request_body(request):
    return json.loads(request.content)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def client(clock):
    value = TushareClient(TOKEN, sleep=clock.sleep, now=clock.now)
    yield value
    value.close()


@pytest.fixture
def db(tmp_path):
    value = Database(tmp_path / "finance.db")
    yield value
    value.close()
