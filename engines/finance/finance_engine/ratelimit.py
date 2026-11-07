"""小容量令牌桶，避免启动时突发消耗每分钟配额。"""

import time
from collections.abc import Callable


class TokenBucket:
    def __init__(
        self,
        per_minute: int,
        *,
        now: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.rate = per_minute / 60
        self.now = now
        self.sleep = sleep
        self.tokens = 1.0
        self.updated = now()

    def acquire(self) -> None:
        while True:
            current = self.now()
            self.tokens = min(1.0, self.tokens + max(0, current - self.updated) * self.rate)
            self.updated = current
            if self.tokens >= 1 - 1e-9:
                self.tokens = 0
                return
            self.sleep((1 - self.tokens) / self.rate)
