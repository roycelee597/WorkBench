"""仅维护可重建的 finance.db，不接触用户的 workbench.db。"""

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from importlib.resources import files
from pathlib import Path

from . import SCHEMA_VERSION, __version__
from .errors import EngineError


def timestamp() -> int:
    return time.time_ns() // 1_000_000


@contextmanager
def database_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock").open("a+b")
    try:
        if lock.seek(0, 2) == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise EngineError("DB_BUSY", "金融数据已被另一个进程占用", retryable=True) from None
        yield
    finally:
        # 关闭句柄自动释放锁；保留文件可避免删除/重建锁文件的竞争。
        lock.close()


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=5)
        self.conn.row_factory = sqlite3.Row
        if not self.conn.execute("SELECT name FROM sqlite_master WHERE name='meta'").fetchone():
            # 非空未知数据库不能被当作新库覆盖。
            if self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                self.close()
                raise EngineError("DB_ERROR", "数据库结构未知，请重建金融数据")
            self.conn.executescript(
                files("finance_engine").joinpath("schema.sql").read_text("utf8")
            )
            with self.conn:
                self.conn.executemany(
                    "INSERT INTO meta VALUES (?,?)",
                    [
                        ("schema_version", str(SCHEMA_VERSION)),
                        ("engine_version", __version__),
                        ("created_at", str(timestamp())),
                    ],
                )
        version = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if not version or version[0] != str(SCHEMA_VERSION):
            self.close()
            raise EngineError("DB_ERROR", "金融数据库版本不兼容，请更新 App 或重建金融数据")
        self.conn.execute("PRAGMA journal_mode=WAL")

    def close(self) -> None:
        self.conn.close()

    def mark(
        self,
        dataset: str,
        day: int,
        status: str,
        rows: int = 0,
        error: str | None = None,
        *,
        attempts: int | None = None,
        fetched_at: int | None = None,
    ) -> None:
        if fetched_at is None:
            fetched_at = timestamp()
        self.conn.execute(
            """INSERT INTO dataset_status VALUES (?,?,?,?,?,COALESCE(?,1),?,?)
               ON CONFLICT(dataset,trade_date) DO UPDATE SET status=excluded.status,
               rows=excluded.rows, source=excluded.source, attempts=COALESCE(?,attempts+1),
               last_error=excluded.last_error, fetched_at=excluded.fetched_at""",
            (dataset, day, status, rows, "tushare", attempts, error, fetched_at, attempts),
        )

    def points(self, points: list) -> dict[str, list[str]]:
        fresh: dict[str, list[str]] = {}
        with self.conn:
            for point in points:
                existing = self.conn.execute(
                    "SELECT value FROM indicator_values WHERE series_key=? AND trade_date=?",
                    (point.key, point.day),
                ).fetchone()
                if point.value is not None and (existing is None or existing[0] is None):
                    fresh.setdefault(point.key, []).append(str(point.day))
                if existing and existing[0] is not None and point.value is None:
                    # 暂时缺依赖时保留已发布数值，避免历史回补破坏最新可用结果。
                    if point.extra.get("status") == "pending":
                        continue
                self.conn.execute(
                    """INSERT INTO indicator_values VALUES (?,?,?,?,?,?)
                       ON CONFLICT(series_key,trade_date) DO UPDATE SET value=excluded.value,
                       extra_json=excluded.extra_json,computed_at=excluded.computed_at,
                       engine_version=excluded.engine_version""",
                    (
                        point.key,
                        point.day,
                        point.value,
                        json.dumps(point.extra, ensure_ascii=False, allow_nan=False),
                        timestamp(),
                        __version__,
                    ),
                )
        return fresh

    def through(self) -> dict[str, str]:
        return {
            row[0]: str(row[1])
            for row in self.conn.execute(
                "SELECT series_key, MAX(trade_date) FROM indicator_values "
                "WHERE value IS NOT NULL GROUP BY series_key"
            )
        }

    def status(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "datasets": [
                dict(row)
                for row in self.conn.execute(
                    "SELECT dataset,status,COUNT(*) AS days,MIN(trade_date) AS first_date,"
                    "MAX(trade_date) AS through FROM dataset_status GROUP BY dataset,status"
                )
            ],
            "through": self.through(),
            "last_run": next(
                (
                    dict(row)
                    for row in self.conn.execute(
                        "SELECT * FROM run_log ORDER BY started_at DESC LIMIT 1"
                    )
                ),
                None,
            ),
            "bytes": self.path.stat().st_size,
        }
