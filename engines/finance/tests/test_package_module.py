import hashlib
import importlib.util
import json
from pathlib import Path
from zipfile import ZipFile

script = Path(__file__).resolve().parents[1] / "scripts/package_module.py"
spec = importlib.util.spec_from_file_location("package_module", script)
assert spec is not None and spec.loader is not None
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def test_bundled_manifest_matches_installed_engine_and_entry(tmp_path):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<html></html>", encoding="utf-8")
    engine = tmp_path / "test-engine.exe"
    engine.write_bytes(b"MZfixture")
    output = tmp_path / "official/finance.wbpkg"

    builder.package(engine, frontend, output)
    with ZipFile(output) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["id"] == "com.royce.workbench.finance"
        assert manifest["engine"]["concurrency"] == 1
        assert manifest["engine"]["sha256"] == hashlib.sha256(engine.read_bytes()).hexdigest()
        assert archive.read(manifest["engine"]["path"]) == engine.read_bytes()
        assert archive.read(manifest["entry"]) == b"<html></html>"
