import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    engine_dir = Path(__file__).resolve().parents[1]
    build_dir = engine_dir / "build"
    build_dir.mkdir(exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--onefile",
            "--noupx",
            # demoparser2 的原生扩展在运行时加载这些模块。
            "--hidden-import",
            "pandas",
            "--hidden-import",
            "polars",
            "--hidden-import",
            "pyarrow",
            "--name",
            "cs2-engine",
            "--distpath",
            str(engine_dir / "dist"),
            "--workpath",
            str(build_dir),
            "--specpath",
            str(build_dir),
            str(engine_dir / "scripts" / "sidecar_entry.py"),
        ],
        cwd=engine_dir,
        check=True,
    )
