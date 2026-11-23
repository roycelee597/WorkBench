"""组装随 WorkBench 分发的金融模块；摘要覆盖 ZIP 中的实际引擎。"""

import argparse
import hashlib
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / "workbenches/finance"
TAURI = ROOT / "apps/desktop/src-tauri"


def package(engine: Path, frontend: Path, output: Path) -> None:
    manifest = json.loads((MODULE / "manifest.json").read_text(encoding="utf-8"))
    if not (frontend / manifest["entry"]).is_file():
        raise SystemExit("金融模块前端尚未构建")
    executable = engine.read_bytes()
    if not executable.startswith(b"MZ"):
        raise SystemExit("金融引擎不是 Windows 可执行文件")
    manifest["engine"]["sha256"] = hashlib.sha256(executable).hexdigest()
    assets = sorted(path for path in frontend.rglob("*") if path.is_file())
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=output.parent, delete=False) as scratch:
        temporary = Path(scratch.name)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
            archive.writestr(manifest["engine"]["path"], executable)
            for path in assets:
                archive.write(path, path.relative_to(frontend).as_posix())
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"已打包金融模块：{output.name}（{output.stat().st_size} 字节）")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--engine",
        type=Path,
        default=TAURI / "binaries/finance-engine-x86_64-pc-windows-msvc.exe",
    )
    parser.add_argument("--frontend", type=Path, default=MODULE / "dist")
    parser.add_argument("--output", type=Path, default=TAURI / "bundled/finance.wbpkg")
    args = parser.parse_args()
    package(args.engine, args.frontend, args.output)


if __name__ == "__main__":
    main()
