"""更新编排：先发布最新值，再回补历史；业务逻辑与桌面端无关。"""

import json
import sqlite3
import time
import uuid
from datetime import datetime
from pathlib import Path

from . import __version__
from .datasets import adj_factor, index_daily, index_valuation, stock_basic, stock_daily, trade_cal
from .db import Database, database_lock, timestamp
from .errors import EngineError, redact
from .indicators import INDICATORS
from .indicators.base import ComputeContext, SeriesPoint
from .indicators.index_valuation import INDICES
from .planner import SHANGHAI, STOCK_START, VALUATION_START, day_number, plan_stock, ready_days
from .protocol import Protocol
from .sources.tushare import TushareClient


def verify(client: TushareClient) -> None:
    client.request("trade_cal", {"exchange": "SSE", "limit": 1}, trade_cal.FIELDS)
    client.request(
        "adj_factor", {"ts_code": "000001.SZ", "limit": 1}, ["ts_code", "trade_date", "adj_factor"]
    )


class Update:
    def __init__(self, db: Database, client: TushareClient, protocol: Protocol, now: datetime):
        self.db, self.client, self.protocol, self.now = db, client, protocol, now
        self.days: list[int] = []
        self.partial = False
        self.fresh: dict[str, set[str]] = {}
        self.stock_indicators = [
            indicator for indicator in INDICATORS if "stock_daily" in indicator.depends_on
        ]
        self.index_indicators = [
            indicator for indicator in INDICATORS if "stock_daily" not in indicator.depends_on
        ]

    def warn(self, error: EngineError, **fields: object) -> None:
        self.partial = True
        self.protocol.error(error, warning=True, **fields)

    def states(self) -> dict[tuple[str, int], str]:
        return {
            (row[0], row[1]): row[2]
            for row in self.db.conn.execute("SELECT dataset,trade_date,status FROM dataset_status")
        }

    def stage(self, name: str) -> None:
        self.protocol.emit("stage", stage=name)

    def publish(self, indicator, dates: list[int]) -> None:
        ctx = ComputeContext(self.db.conn, self.days)
        states = self.states()
        if indicator.id == "top5_turnover_share":
            dates = [day for day in dates if states.get(("stock_daily", day)) == "ok"]
        points = indicator.compute(ctx, dates)
        if indicator.id == "new_high_60d_share":
            market = [day for day in self.days if day >= STOCK_START]
            positions = {day: i for i, day in enumerate(market)}
            for i, point in enumerate(points):
                pos = positions[point.day]
                if pos >= 59 and any(
                    states.get(("stock_daily", day)) != "ok" for day in market[pos - 59 : pos + 1]
                ):
                    points[i] = SeriesPoint(point.key, point.day, None, {"status": "pending"})
                # 复权因子由计算函数按当日实际入选的股票检查。
                if points[i].extra.get("status") == "pending":
                    self.partial = True
        fresh = self.db.points(points)
        for key, days in fresh.items():
            self.fresh.setdefault(key, set()).update(days)
        through = self.db.through()
        matching = [
            day
            for key, day in through.items()
            if key == indicator.id
            or (indicator.id == "index_valuation" and key.startswith("valuation."))
        ]
        if matching:
            self.protocol.emit("indicator_updated", indicator=indicator.id, through=max(matching))

    def indices(self) -> None:
        self.stage("index")
        available = ready_days(self.days, self.now, 19, VALUATION_START)
        states = self.states()
        today = day_number(self.now)
        if self.days and self.days[-1] == today and self.now.astimezone(SHANGHAI).hour < 19:
            self.warn(EngineError("DATA_NOT_READY", "今日指数数据尚未发布", retryable=True))
        for code in INDICES:
            pending = [
                day
                for day in available
                if day in available[-3:]
                or states.get(("index_valuation." + code, day)) not in ("ok", "empty")
            ]
            try:
                if not index_valuation.refresh(self.db, self.client, code, pending, today):
                    self.warn(
                        EngineError("DATA_NOT_READY", "指数估值尚未完整发布", retryable=True),
                        dataset="index_valuation." + code,
                    )
            except EngineError as error:
                if error.code == "TOKEN_INVALID":
                    raise
                self.warn(error, dataset="index_valuation." + code)
        overlay_days = [day for day in available if day >= STOCK_START]
        pending = [
            day
            for day in overlay_days
            if day in overlay_days[-3:] or states.get(("index_daily.000300.SH", day)) != "ok"
        ]
        try:
            if not index_daily.refresh(self.db, self.client, pending, today):
                self.warn(EngineError("DATA_NOT_READY", "沪深300 收盘尚未发布", retryable=True))
        except EngineError as error:
            if error.code == "TOKEN_INVALID":
                raise
            self.warn(error, dataset="index_daily")
        for indicator in self.index_indicators:
            self.publish(indicator, available)

    def stocks(self, stage: str, dates: list[int]) -> None:
        self.stage(stage)
        started = time.monotonic()
        for done, day in enumerate(dates, 1):
            try:
                if not stock_daily.refresh(
                    self.db,
                    self.client,
                    day,
                    day_number(self.now),
                    warn=lambda notice, day=day: self.protocol.error(
                        notice, warning=True, dataset="stock_daily", trade_date=str(day)
                    ),
                ):
                    dataset, status, message = self.db.conn.execute(
                        "SELECT dataset,status,last_error FROM dataset_status "
                        "WHERE trade_date=? AND dataset IN ('stock_daily','adj_factor') "
                        "AND status<>'ok' ORDER BY dataset='stock_daily' DESC LIMIT 1",
                        (day,),
                    ).fetchone()
                    self.warn(
                        EngineError("DATA_NOT_READY", message, retryable=status == "pending"),
                        dataset=dataset,
                        trade_date=str(day),
                    )
            except EngineError as error:
                if error.code in ("TOKEN_INVALID", "PERMISSION_DENIED", "UPSTREAM_SCHEMA"):
                    raise
                stock_daily.mark_fetch_failure(
                    self.db, day, "error", redact(error, self.client.token)
                )
                self.warn(error, dataset="stock_daily", trade_date=str(day))
            elapsed = time.monotonic() - started
            self.protocol.emit(
                "progress",
                stage=stage,
                done=done,
                total=len(dates),
                current=str(day),
                eta_seconds=int(elapsed / done * (len(dates) - done)),
            )

    def run(self, calendar_rows: list[dict]) -> None:
        trade_cal.store(self.db, calendar_rows)
        self.days = [
            int(row[0])
            for row in self.db.conn.execute(
                "SELECT cal_date FROM trade_calendar WHERE is_open=1 AND cal_date<=? "
                "ORDER BY cal_date",
                (day_number(self.now),),
            )
        ]
        if not self.days:
            raise EngineError("UPSTREAM_SCHEMA", "交易日历没有可用开市日")
        self.stage("stock_basic")
        stock_basic.refresh(self.db, self.client)
        with self.db.conn:
            for indicator in INDICATORS:
                self.db.conn.execute(
                    "INSERT OR REPLACE INTO indicator_meta VALUES (?,?,?)",
                    (indicator.id, json.dumps(indicator.meta(), ensure_ascii=False), timestamp()),
                )
            self.db.conn.execute(
                "UPDATE meta SET value=? WHERE key='engine_version'", (__version__,)
            )
        self.indices()
        available = ready_days(self.days, self.now, 16, STOCK_START)
        exhausted_daily = stock_daily.exhausted_days(self.db)
        plan = plan_stock(
            self.days,
            self.states(),
            self.now,
            exhausted_daily=exhausted_daily,
            exhausted_factors=adj_factor.exhausted_days(self.db),
        )
        if exhausted_daily.intersection(available):
            self.partial = True
        if self.days[-1] == day_number(self.now) and self.now.astimezone(SHANGHAI).hour < 16:
            self.warn(EngineError("DATA_NOT_READY", "今日个股日线尚未发布", retryable=True))
        self.stocks("recent", plan.recent)
        if available:
            for indicator in self.stock_indicators:
                self.publish(indicator, available[-1:])
        self.stocks("backfill", plan.backfill)
        self.stage("compute")
        changed = set(plan.recent + plan.backfill)
        affected = set()
        for index, day in enumerate(available):
            if day in changed:
                affected.update(available[index : index + 60])
        # 原始数据提交后可能中断，缺少结果和仍未就绪的点都要重新检查。
        for indicator in self.stock_indicators:
            written = {
                row[0]
                for row in self.db.conn.execute(
                    "SELECT trade_date FROM indicator_values WHERE series_key=? "
                    "AND (value IS NOT NULL "
                    "OR json_extract(extra_json,'$.status') IS NOT 'pending')",
                    (indicator.id,),
                )
            }
            self.publish(indicator, sorted(affected | (set(available) - written)))


def update(
    path: Path, client: TushareClient, protocol: Protocol, now: datetime, mode: str = "auto"
) -> int:
    with database_lock(path):
        db = Database(path)
        run_id, started = str(uuid.uuid4()), timestamp()
        status, failure, job = "failed", None, None
        try:
            with db.conn:
                db.conn.execute(
                    "INSERT INTO run_log VALUES (?,?,NULL,?,'running',NULL,NULL,NULL)",
                    (run_id, started, mode),
                )
            protocol.emit("stage", stage="calendar")
            # 首个请求失败时，除了 run_log 不改任何现有行情、元数据或完成标记。
            calendar_rows = trade_cal.fetch(client, now.astimezone(SHANGHAI).year)
            if not calendar_rows:
                raise EngineError("UPSTREAM_SCHEMA", "交易日历为空，拒绝开始更新")
            if mode == "full-rebuild":
                db.close()
                try:
                    for target in (
                        path,
                        path.with_name(path.name + "-wal"),
                        path.with_name(path.name + "-shm"),
                    ):
                        target.unlink(missing_ok=True)
                finally:
                    # 删除失败时重新连接已有库，仍能记录失败并返回受控错误。
                    db = Database(path)
            job = Update(db, client, protocol, now)
            job.run(calendar_rows)
            status = "partial" if job.partial else "ok"
        except EngineError as error:
            failure = error
            protocol.error(error)
        except (sqlite3.Error, OSError) as error:
            failure = EngineError("DB_ERROR", redact(error, client.token))
            protocol.error(failure)
        except Exception as error:
            failure = EngineError("INTERNAL", redact(error, client.token))
            protocol.error(failure)
        finally:
            summary = {
                "calls": dict(client.calls),
                "upstream_errors": client.errors,
                "elapsed_seconds": (timestamp() - started) / 1000,
                "new_dates": {key: sorted(days) for key, days in job.fresh.items()} if job else {},
                "through": db.through(),
            }
            try:
                with db.conn:
                    db.conn.execute(
                        "INSERT OR REPLACE INTO run_log VALUES (?,?,?,?,?,?,?,?)",
                        (
                            run_id,
                            started,
                            timestamp(),
                            mode,
                            status,
                            failure.code if failure else None,
                            redact(failure, client.token) if failure else None,
                            redact(json.dumps(summary, ensure_ascii=False), client.token),
                        ),
                    )
                protocol.emit(
                    "done",
                    status=status,
                    new_dates={key: sorted(days) for key, days in job.fresh.items()} if job else {},
                    through=db.through(),
                )
            finally:
                db.close()
        return failure.exit_code if failure else 0
