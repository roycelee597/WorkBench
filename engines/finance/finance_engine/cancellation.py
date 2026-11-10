"""进程控制文件只传递停止信号，凭据仍由 stdin 传入。"""

import time
from pathlib import Path

from .errors import EngineError


class Cancellation:
    def __init__(self, path: Path):
        self.path = path

    def check(self) -> None:
        if self.path.exists():
            raise EngineError("CANCELLED", "金融引擎已收到停止请求")

    def sleep(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while True:
            self.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 0.1))
