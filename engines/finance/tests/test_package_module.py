import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile


def test_bundled_manifest_matches_installed_engine_and_entry(tmp_path):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<html></html>", encoding="utf-8")
    engine = tmp_path / "test-engine.exe"
    engine.write_bytes(b"MZfixture")
    output = tmp_path / "official/finance.wbpkg"

    script = Path(__file__).resolve().parents[1] / "scripts/package_module.py"
    result = subprocess.run(
        [sys.executable, script, "--engine", engine, "--frontend", frontend, "--output", output],
        env={**os.environ, "PYTHONIOENCODING": "cp1252"},
        check=True,
        capture_output=True,
    )
    assert "已打包金融模块：finance.wbpkg" in result.stdout.decode("utf-8")
    with ZipFile(output) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["id"] == "com.royce.workbench.finance"
        assert manifest["engine"]["concurrency"] == 1
        assert manifest["engine"]["sha256"] == hashlib.sha256(engine.read_bytes()).hexdigest()
        assert archive.read(manifest["engine"]["path"]) == engine.read_bytes()
        assert archive.read(manifest["entry"]) == b"<html></html>"
