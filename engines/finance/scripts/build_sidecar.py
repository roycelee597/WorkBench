"""打包 Windows x64 sidecar；AKShare 只在显式指定时收集。"""

import argparse
import importlib.util
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

NAME = "finance-engine-x86_64-pc-windows-msvc"


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    engine = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--with-akshare", action="store_true", help="显式收集可选 AKShare 及其依赖")
    parser.add_argument(
        "--dist-dir", type=Path, default=engine.parents[1] / "apps/desktop/src-tauri/binaries"
    )
    parser.add_argument("--work-dir", type=Path, default=engine / ".local/sidecar-build")
    args = parser.parse_args(argv)
    # PyInstaller 的工作目录是引擎目录，自定义相对路径须先按调用位置固定。
    args.dist_dir = args.dist_dir.resolve()
    args.work_dir = args.work_dir.resolve()
    return args


def build_command(engine: Path, args: argparse.Namespace) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--log-level",
        "WARN",
        "--name",
        NAME,
        "--collect-data",
        "finance_engine",
        "--distpath",
        str(args.dist_dir),
        "--workpath",
        str(args.work_dir),
        "--specpath",
        str(args.work_dir),
    ]
    if args.with_akshare:
        # AKShare 的新浪接口延迟使用 V8；仅收集 akshare 会漏掉 DLL 和 ICU 数据。
        command.extend(["--collect-all", "akshare", "--collect-all", "py_mini_racer"])
    else:
        command.extend(["--exclude-module", "akshare"])
    command.append(str(engine / "scripts/sidecar_entry.py"))
    return command


def main(argv: list[str] | None = None) -> None:
    if platform.system() != "Windows" or platform.machine().upper() != "AMD64":
        raise SystemExit("金融引擎打包需要 Windows x64")
    args = arguments(argv)
    if args.with_akshare and importlib.util.find_spec("akshare") is None:
        raise SystemExit("请先安装 akshare extra，再使用 --with-akshare")
    engine = Path(__file__).resolve().parents[1]
    args.dist_dir.mkdir(parents=True, exist_ok=True)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(build_command(engine, args), check=True, cwd=engine)
    binary = args.dist_dir / (NAME + ".exe")
    started = time.perf_counter()
    version = json.loads(subprocess.check_output([str(binary), "--version"], timeout=45))
    elapsed = time.perf_counter() - started
    if version.get("type") != "hello" or not version.get("engine_version"):
        raise SystemExit("金融引擎版本冒烟测试失败")
    print(
        json.dumps(
            {
                **version,
                "bytes": binary.stat().st_size,
                "startup_seconds": elapsed,
                "with_akshare": args.with_akshare,
            }
        )
    )


if __name__ == "__main__":
    main()
