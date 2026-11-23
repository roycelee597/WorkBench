"""仅为 P0-2 Windows 验收准备旧版合成数据，禁止使用正式目录或凭据。"""

import argparse
import ctypes
import hashlib
import json
import re
import sqlite3
import uuid
from ctypes import wintypes
from pathlib import Path

from finance_engine.db import Database
from finance_engine.engine import INDICATORS

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "apps/desktop/src-tauri/migrations"
STAMP = 1_800_000_000_000
LAST_DAY = 20261120
VALUE = 43.25
FAKE_CREDENTIAL = "p02-offline-fixture-Q4PL"


class Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def install_fake_credential(identifier):
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    target = f"tushare.{identifier}.finance"
    blob = FAKE_CREDENTIAL.encode("utf-16-le")
    buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
    credential = Credential(
        Type=1,
        TargetName=target,
        Comment="WorkBench P0-2 虚构验收凭据",
        CredentialBlobSize=len(blob),
        CredentialBlob=buffer,
        Persist=2,
        UserName="tushare",
    )
    if not api.CredWriteW(ctypes.byref(credential), 0):
        raise ctypes.WinError(ctypes.get_last_error())


def row_id():
    return str(uuid.UUID(int=(STAMP << 80) | (7 << 76) | (2 << 62) | (uuid.uuid4().int >> 66)))


def seed_workbench(path):
    with sqlite3.connect(path) as db:
        db.execute(
            """CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY,description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,execution_time BIGINT NOT NULL)"""
        )
        for version, description in enumerate(
            (
                "初始化工作台数据表",
                "提醒调度起点与实例状态",
                "金融阈值与评估状态",
                "本机 AI 对话记录",
                "模块备忘录所有权",
            ),
            start=1,
        ):
            raw = next(MIGRATIONS.glob(f"{version:04d}_*.sql")).read_bytes()
            db.executescript(raw.decode("utf-8"))
            db.execute(
                "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time)"
                " VALUES (?,?,1,?,0)",
                (version, description, hashlib.sha384(raw).digest()),
            )
        for key, value in {
            "device_id": row_id(),
            "global_shortcut": "Ctrl+Alt+Shift+F10",
            "ai.global_shortcut": "Ctrl+Alt+Shift+F11",
            "autostart_prompted": True,
            "finance.overlay_hs300": False,
            # 保留虚构凭据用于迁移核对，等待用户确认才能更新。
            "finance.initial_backfill_confirmed": False,
        }.items():
            db.execute(
                "INSERT INTO settings (id,created_at,updated_at,device_id,key,value)"
                " VALUES (?,?,?,?,?,?)",
                (row_id(), STAMP, STAMP, "fixture", key, json.dumps(value)),
            )
        threshold = row_id()
        db.execute(
            "INSERT INTO finance_thresholds "
            "(id,created_at,updated_at,device_id,indicator_id,series_key,direction,level,label) "
            "VALUES (?,?,?,'fixture','top5_turnover_share','top5_turnover_share','above',75,?)",
            (threshold, STAMP, STAMP, "P0-2 旧版阈值"),
        )
        reminder = row_id()
        db.execute(
            "INSERT INTO reminders "
            "(id,created_at,updated_at,device_id,title,source_workbench,completed_at) "
            "VALUES (?,?,?,'fixture',?,'com.royce.workbench.finance',?)",
            (reminder, STAMP, STAMP, "P0-2 旧版金融提醒", STAMP),
        )
        db.execute(
            "INSERT INTO finance_alert_states "
            "(id,created_at,updated_at,device_id,threshold_id,threshold_version,breached,"
            "evaluated_through,last_reminder_id) VALUES (?,?,?,'fixture',?,?,0,?,?)",
            (row_id(), STAMP, STAMP, threshold, STAMP, LAST_DAY, reminder),
        )
        db.execute(
            "INSERT INTO memos (id,created_at,updated_at,device_id,title) "
            "VALUES (?,?,?,'fixture',?)",
            (row_id(), STAMP, STAMP, "P0-2 综合保留"),
        )
        db.execute(
            "INSERT INTO ai_messages (id,created_at,updated_at,device_id,role,text)"
            " VALUES (?,?,?,'fixture','user',?)",
            (row_id(), STAMP, STAMP, "P0-2 AI 保留"),
        )


def seed_finance(path):
    finance = Database(path)
    try:
        with finance.conn:
            for indicator in INDICATORS:
                finance.conn.execute(
                    "INSERT INTO indicator_meta VALUES (?,?,?)",
                    (indicator.id, json.dumps(indicator.meta(), ensure_ascii=False), STAMP),
                )
            finance.conn.execute("INSERT INTO trade_calendar VALUES (?,1)", (LAST_DAY,))
            finance.conn.execute(
                "INSERT INTO indicator_values VALUES ('top5_turnover_share',?,?,NULL,?,'0.1.0')",
                (LAST_DAY, VALUE, STAMP),
            )
    finally:
        finance.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suffix", help="隔离实例后缀，只允许小写字母和数字")
    suffix = parser.parse_args().suffix
    if not re.fullmatch(r"[a-z0-9]{3,16}", suffix):
        parser.error("后缀须为 3 至 16 位小写字母或数字")
    identifier = f"com.royce.workbench.p02-check-{suffix}"
    root = ROOT / "dist" / f"finance-module-check-{suffix}"
    data = root / "app"
    root.mkdir(exist_ok=False)
    data.mkdir()
    seed_workbench(data / "workbench.db")
    seed_finance(data / "finance.db")
    config = {
        "productName": f"WorkBench-P02-{suffix}",
        "identifier": identifier,
        "app": {
            "appDirectoriesOverride": str(data),
            "windows": [
                {
                    "label": "main",
                    "title": f"WorkBench P0-2 验收（{suffix}）",
                    "width": 1200,
                    "height": 800,
                }
            ],
        },
    }
    (root / "tauri.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    install_fake_credential(identifier)
    print(f"已准备隔离数据与配置：dist/finance-module-check-{suffix}/")


if __name__ == "__main__":
    main()
