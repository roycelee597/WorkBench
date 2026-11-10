"""打包 Windows x64 sidecar，并运行版本冒烟测试。"""

import json
import platform
import subprocess
import sys
from pathlib import Path

if platform.system() != "Windows" or platform.machine().upper() != "AMD64":
    raise SystemExit("金融引擎打包需要 Windows x64")

engine = Path(__file__).resolve().parents[1]
destination = engine.parents[1] / "apps/desktop/src-tauri/binaries"
scratch = engine / ".local/sidecar-build"
scratch.mkdir(parents=True, exist_ok=True)
name = "finance-engine-x86_64-pc-windows-msvc"
subprocess.run(
    [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--log-level",
        "WARN",
        "--name",
        name,
        "--collect-data",
        "finance_engine",
        "--distpath",
        str(destination),
        "--workpath",
        str(scratch),
        "--specpath",
        str(scratch),
        str(engine / "scripts/sidecar_entry.py"),
    ],
    check=True,
    cwd=engine,
)
binary = destination / (name + ".exe")
version = json.loads(subprocess.check_output([str(binary), "--version"], timeout=45))
if version.get("type") != "hello" or not version.get("engine_version"):
    raise SystemExit("金融引擎版本冒烟测试失败")
print(json.dumps({**version, "bytes": binary.stat().st_size}))
