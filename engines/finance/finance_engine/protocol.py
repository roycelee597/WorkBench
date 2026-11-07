"""stdin 密钥与 stdout NDJSON；禁止向 stdout 输出普通日志。"""

import json
import sys
from typing import TextIO

from .errors import EngineError, redact


class Protocol:
    def __init__(self, output: TextIO | None = None, token: str = ""):
        if output is None and hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        self.output = output if output is not None else sys.stdout
        self.token = token

    def emit(self, event_type: str, **fields: object) -> None:
        # 最后一道脱敏防线也覆盖上游意外返回的 token。
        payload = json.dumps({"type": event_type, **fields}, ensure_ascii=False, allow_nan=False)
        self.output.write(redact(payload, self.token) + "\n")
        self.output.flush()

    def error(self, error: EngineError, *, warning: bool = False, **fields: object) -> None:
        self.emit(
            "warning" if warning else "error",
            code=error.code,
            message=redact(error, self.token),
            retryable=error.retryable,
            **fields,
        )


def read_secrets(stream: TextIO) -> dict:
    line = stream.readline(16_385)
    try:
        value = json.loads(line)
    except (ValueError, TypeError) as error:
        raise EngineError("TOKEN_MISSING", "请通过 stdin 提供一行 JSON 密钥") from error
    if not isinstance(value, dict) or not isinstance(value.get("tushare_token"), str):
        raise EngineError("TOKEN_MISSING", "未设置 Tushare token")
    token = value["tushare_token"].strip()
    if not token or len(token) > 4096 or len(line) > 16_384:
        raise EngineError("TOKEN_MISSING", "Tushare token 为空或长度无效")
    if "akshare_fallback" in value and not isinstance(value["akshare_fallback"], bool):
        raise EngineError("ARGUMENT", "备用源选项必须为布尔值")
    return {"tushare_token": token, "akshare_fallback": value.get("akshare_fallback", True)}
