"""协议错误与密钥脱敏。"""

import re


def redact(message: object, token: str = "") -> str:
    text = str(message)
    if token:
        text = text.replace(token, "[已隐藏]")
    return re.sub(
        r"(?i)([\"\']?(?:tushare_token|token)[\"\']?\s*[:=]\s*)[\"\']?[^\s,}\"\']+",
        r"\1[已隐藏]",
        text,
    )


class EngineError(Exception):
    def __init__(
        self, code: str, message: str, *, retryable: bool = False, upstream: dict | None = None
    ):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.upstream = upstream

    @property
    def exit_code(self) -> int:
        if self.code == "ARGUMENT":
            return 2
        if self.code in ("INTERNAL", "DB_ERROR"):
            return 1
        return 4 if self.retryable else 3
