"""打包配置必须显式选择 AKShare，默认命令不携带可选依赖。"""

import importlib.util
import json
from pathlib import Path

import pytest

script = Path(__file__).resolve().parents[1] / "scripts/build_sidecar.py"
spec = importlib.util.spec_from_file_location("build_sidecar", script)
assert spec is not None and spec.loader is not None
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def test_default_packaging_keeps_existing_paths_and_excludes_akshare():
    args = builder.arguments([])
    engine = script.parents[1]
    assert args.dist_dir == engine.parents[1] / "apps/desktop/src-tauri/binaries"
    assert args.work_dir == engine / ".local/sidecar-build"
    command = builder.build_command(engine, args)
    assert command[command.index("--exclude-module") + 1] == "akshare"
    assert "--collect-all" not in command
    assert "--onefile" in command


def test_opt_in_collects_akshare_and_its_data_in_separate_output(tmp_path):
    args = builder.arguments(
        [
            "--with-akshare",
            "--dist-dir",
            str(tmp_path / "dist"),
            "--work-dir",
            str(tmp_path / "work"),
        ]
    )
    command = builder.build_command(script.parents[1], args)
    assert command[command.index("--collect-all") + 1] == "akshare"
    assert [command[i + 1] for i, arg in enumerate(command) if arg == "--collect-all"] == [
        "akshare",
        "py_mini_racer",
    ]
    assert "--exclude-module" not in command
    assert command[command.index("--distpath") + 1] == str(tmp_path / "dist")
    assert command[command.index("--workpath") + 1] == str(tmp_path / "work")


def test_missing_optional_dependency_refuses_opt_in_before_build(monkeypatch):
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    monkeypatch.setattr(builder.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(builder.importlib.util, "find_spec", lambda _name: None)
    with pytest.raises(SystemExit, match="请先安装 akshare extra"):
        builder.main(["--with-akshare"])


def test_build_smoke_only_runs_version_and_reports_measurement(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    monkeypatch.setattr(builder.platform, "machine", lambda: "AMD64")
    calls = []

    def package(command, **kwargs):
        calls.append((command, kwargs))
        output = Path(command[command.index("--distpath") + 1])
        (output / (builder.NAME + ".exe")).write_bytes(b"MZfixture")

    def version(command, **kwargs):
        calls.append((command, kwargs))
        assert command == [str(tmp_path / (builder.NAME + ".exe")), "--version"]
        return b'{"type":"hello","engine_version":"0.1.0","schema_version":1}'

    monkeypatch.setattr(builder.subprocess, "run", package)
    monkeypatch.setattr(builder.subprocess, "check_output", version)
    builder.main(["--dist-dir", str(tmp_path), "--work-dir", str(tmp_path / "work")])
    result = json.loads(capsys.readouterr().out)
    assert result["bytes"] == 9
    assert result["with_akshare"] is False
    assert result["startup_seconds"] >= 0
    assert len(calls) == 2
    assert calls[0][1]["check"] is True
    assert calls[1][1]["timeout"] == 45
