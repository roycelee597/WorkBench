"""只提供三个同口径备用入口；未安装时静默跳过，调用失败不覆盖主源缓存。"""

import math
import re
import sys
from collections.abc import Callable
from contextlib import redirect_stdout
from datetime import date, datetime
from importlib import import_module

from ..errors import EngineError
from ..indicators.base import SeriesPoint
from ..indicators.top5_turnover import top5_turnover
from ..planner import SHANGHAI, VALUATION_START, day_number


def market_day(value: object) -> int:
    parsed = date.fromisoformat(str(value)[:10])
    return parsed.year * 10000 + parsed.month * 100 + parsed.day


class AkshareFallback:
    def __init__(
        self,
        enabled: bool = True,
        *,
        check_cancelled: Callable[[], None] = lambda: None,
        warn: Callable[[EngineError], None] = lambda _error: None,
        clock: Callable[[], datetime] = lambda: datetime.now(SHANGHAI),
    ):
        self.enabled = enabled
        self.check_cancelled = check_cancelled
        self.warn = warn
        self.clock = clock
        self.module = None
        self.loaded = False
        self.index_frame = None

    def available(self) -> bool:
        if not self.enabled:
            return False
        self.check_cancelled()
        if not self.loaded:
            self.loaded = True
            try:
                # 动态导入避免默认打包收集可选依赖；构建包含版时显式 collect-all。
                with redirect_stdout(sys.stderr):
                    self.module = import_module("akshare")
            except (ImportError, OSError):
                self.module = None
            except Exception:
                self.warn(EngineError("AKSHARE_FAILED", "AKShare 可选组件无法加载，跳过备用源"))
                self.module = None
        self.check_cancelled()
        return self.module is not None

    def attempt(self, operation: Callable[[], object]):
        if not self.available():
            return None
        try:
            # 第三方的进度或调试输出不能混入 stdout 的 NDJSON 协议。
            with redirect_stdout(sys.stderr):
                result = operation()
            self.check_cancelled()
            return result
        except EngineError as error:
            if error.code == "CANCELLED":
                raise
            self.warn(error)
        except Exception:
            self.warn(EngineError("AKSHARE_FAILED", "AKShare 备用数据暂不可用，保留已有缓存"))
        return None

    def calendar(self, year: int) -> list[dict] | None:
        def read():
            frame = self.module.tool_trade_date_hist_sina()
            days = [market_day(value) for value in frame["trade_date"]]
            if not days or len(days) != len(set(days)):
                raise ValueError("交易日历为空或重复")
            # 新浪仅列出开市日，不把缺失的日期猜测为休市，也不删除已有交易所日历。
            return [
                {"cal_date": day, "is_open": 1, "source": "akshare"}
                for day in sorted(days)
                if VALUATION_START <= day <= year * 10000 + 1231
            ] or None

        return self.attempt(read)

    def index(self, dates: list[int]) -> list[dict] | None:
        actual = self.clock().astimezone(SHANGHAI)
        today = day_number(actual)
        dates = [day for day in dates if day < today or (day == today and actual.hour >= 19)]
        if not dates:
            return None

        def read():
            if self.index_frame is None:
                self.index_frame = self.module.stock_zh_index_daily(symbol="sh000300")
            wanted = set(dates)
            result = []
            for row in self.index_frame.to_dict("records"):
                day = market_day(row["date"])
                if day not in wanted:
                    continue
                close = float(row["close"])
                if not math.isfinite(close) or close <= 0:
                    raise ValueError("指数点位无效")
                result.append(
                    {"ts_code": "000300.SH", "trade_date": day, "close": close, "source": "akshare"}
                )
            if len({row["trade_date"] for row in result}) != len(result):
                raise ValueError("指数日期重复")
            return result or None

        return self.attempt(read)

    def turnover(self, day: int) -> SeriesPoint | None:
        # --now 可以用于重试和规划实测，但不能把实际今日快照写成历史日。
        actual = self.clock().astimezone(SHANGHAI)
        if day != day_number(actual) or actual.hour < 16:
            return None

        def read():
            frame = self.module.stock_zh_a_spot_em()
            rows = []
            seen = set()
            for row in frame.to_dict("records"):
                code = str(row["代码"])
                if not re.fullmatch(r"\d{6}", code):
                    raise ValueError("快照代码无效")
                if not code.startswith(("0", "3", "6")):
                    continue
                code += ".SH" if code.startswith("6") else ".SZ"
                amount = float(row["成交额"]) / 1000  # 东方财富元 → Tushare 千元。
                if code in seen or not math.isfinite(amount):
                    raise ValueError("快照重复或成交额缺失")
                seen.add(code)
                rows.append({"ts_code": code, "amount": amount})
            if day != day_number(self.clock()):
                return None
            point = top5_turnover(day, rows)
            return (
                SeriesPoint(point.key, day, point.value, {**point.extra, "source": "akshare"})
                if point.value is not None
                else None
            )

        return self.attempt(read)
