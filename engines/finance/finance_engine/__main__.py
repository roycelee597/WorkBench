"""finance-engine 命令行入口；token 只从一行 stdin JSON 读取。"""

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from . import SCHEMA_VERSION, __version__
from .cancellation import Cancellation
from .db import Database
from .engine import update, verify
from .errors import EngineError
from .planner import SHANGHAI
from .protocol import Protocol, read_secrets
from .sources.tushare import TushareClient


class Parser(argparse.ArgumentParser):
    def print_help(self, file=None) -> None:
        super().print_help(file=sys.stderr if file is None else file)

    def error(self, message: str) -> None:
        raise EngineError("ARGUMENT", "命令行参数无效，请检查命令、--db、--mode 和 --now")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8-sig")
    protocol = Protocol()
    parser = Parser(description="WorkBench 金融指标引擎")
    parser.add_argument("--version", action="store_true")
    commands = parser.add_subparsers(dest="command")
    for name in ("update", "verify", "status"):
        command = commands.add_parser(name)
        command.add_argument("--db", type=Path, required=True)
        if name in ("update", "verify"):
            command.add_argument("--cancel-file", type=Path)
        if name == "update":
            command.add_argument("--mode", choices=("auto", "full-rebuild"), default="auto")
            command.add_argument("--now")
    client = None
    try:
        args = parser.parse_args(argv)
        if args.version:
            protocol.emit("hello", engine_version=__version__, schema_version=SCHEMA_VERSION)
            return 0
        if not args.command or not args.db.is_absolute():
            raise EngineError("ARGUMENT", "需要命令和 --db 数据库绝对路径")
        protocol.emit("hello", engine_version=__version__, schema_version=SCHEMA_VERSION)
        if args.command == "status":
            if not args.db.exists():
                protocol.emit("status", configured=False, through={}, datasets=[])
                return 0
            # status 严格只读，不创建库、不修改 WAL 或 schema。
            db = Database.__new__(Database)
            db.path = args.db
            db.conn = sqlite3.connect(args.db.as_uri() + "?mode=ro", uri=True)
            db.conn.row_factory = sqlite3.Row
            try:
                version = db.conn.execute(
                    "SELECT value FROM meta WHERE key='schema_version'"
                ).fetchone()
                if not version or version[0] != str(SCHEMA_VERSION):
                    raise EngineError("DB_ERROR", "金融数据库版本不兼容，请更新 App")
                protocol.emit("status", **db.status())
            finally:
                db.close()
            return 0
        secrets = read_secrets(sys.stdin)
        protocol.token = secrets["tushare_token"]
        if args.cancel_file is not None:
            if not args.cancel_file.is_absolute():
                raise EngineError("ARGUMENT", "停止信号文件必须使用绝对路径")
            cancellation = Cancellation(args.cancel_file)
            cancellation.check()
            client = TushareClient(
                protocol.token, sleep=cancellation.sleep, check_cancelled=cancellation.check
            )
        else:
            client = TushareClient(protocol.token)
        if args.command == "verify":
            verify(client)
            protocol.emit("done", status="ok", new_dates={}, through={})
            return 0
        try:
            now = datetime.fromisoformat(args.now) if args.now else datetime.now(SHANGHAI)
            if now.tzinfo is None:
                raise ValueError("缺少时区")
        except ValueError:
            raise EngineError("ARGUMENT", "--now 必须包含时区，例如 +08:00") from None
        return update(args.db, client, protocol, now, args.mode)
    except EngineError as error:
        protocol.error(error)
        return 2 if error.code == "ARGUMENT" else error.exit_code
    except (sqlite3.Error, OSError):
        protocol.error(EngineError("DB_ERROR", "金融数据库无法访问，请检查路径或重建数据"))
        return 1
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
