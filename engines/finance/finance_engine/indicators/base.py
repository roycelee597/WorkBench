"""指标扩展协议及通用序列点。"""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class SeriesPoint:
    key: str
    day: int
    value: float | None
    extra: dict = field(default_factory=dict)


@dataclass
class ComputeContext:
    connection: object
    calendar: list[int]


class Indicator(Protocol):
    id: str
    depends_on: list[str]
    lookback_days: int

    def meta(self) -> dict: ...
    def compute(self, ctx: ComputeContext, dates: list[int]) -> list[SeriesPoint]: ...
