import errno
import os
import subprocess
from pathlib import Path

import pytest

from cs2_engine import native_capture
from cs2_engine.native_capture import cleanup_native_outputs, native_outputs, valid_native_prefix

_PREFIX = "wbp2_" + "a0" * 16
_OTHER_PREFIX = "wbp2_" + "b1" * 16


def _files(root: Path, paths: list[str]) -> set[Path]:
    result = set()
    for relative in paths:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fixture")
        result.add(path)
    return result


def test_discovery_and_cleanup_only_handle_exact_session_files(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("native")
    owned = _files(
        tmp_path,
        [
            f"{_PREFIX}00005.tga",
            f"{_PREFIX}_00006.TGA",
            f"{_PREFIX}.wav",
            f"movie/{_PREFIX}-00007.tga",
            f"movie/{_PREFIX}.00008.tga",
            f"{_PREFIX}/00000.tga",
            f"{_PREFIX}/frame_00001.tga",
            f"{_PREFIX}/audio.WAV",
            f"movie/{_PREFIX}/{_PREFIX}00001.tga",
            f"movie/{_PREFIX}/{_PREFIX}.WAV",
        ],
    )
    other = _files(
        tmp_path,
        [
            "notes.txt",
            f"{_PREFIX}.tga",
            f"{_PREFIX}_00009.wav",
            f"{_PREFIX}-backup00010.tga",
            f"{_PREFIX}/notes00003.tga",
            f"{_PREFIX}/commentary.wav",
            f"{_PREFIX}/nested/00002.tga",
            f"{_PREFIX}backup/frame_00001.tga",
            f"{_OTHER_PREFIX}00000.tga",
            f"{_OTHER_PREFIX}.wav",
            f"movie/{_OTHER_PREFIX}/00000.tga",
        ],
    )
    (tmp_path / f"{_PREFIX}00099.tga").mkdir()
    roots = [tmp_path / "missing", tmp_path]

    assert native_outputs(roots, _PREFIX) == owned
    cleanup_native_outputs(roots, _PREFIX)
    cleanup_native_outputs(roots, _PREFIX)

    assert native_outputs(roots, _PREFIX) == set()
    assert not any(path.exists() for path in owned)
    assert all(path.read_bytes() == b"fixture" for path in other)
    assert (tmp_path / f"{_PREFIX}00099.tga").is_dir()
    assert (tmp_path / "movie").is_dir()


@pytest.mark.parametrize("prefix", ["", "wbp2_" + "A" * 32, _PREFIX + "0", f"../{_PREFIX}", None])
def test_invalid_prefix_is_rejected_before_accessing_files(tmp_path, prefix):
    assert valid_native_prefix(prefix) is False
    with pytest.raises(ValueError, match="录制临时名称无效"):
        native_outputs([tmp_path], prefix)
    with pytest.raises(ValueError, match="录制临时名称无效"):
        cleanup_native_outputs([tmp_path], prefix)


def test_valid_prefix_requires_ascii_lowercase_hex():
    assert valid_native_prefix(_PREFIX)
    assert not valid_native_prefix("wbp2_" + "０" * 32)
    assert not valid_native_prefix(_PREFIX + "\n")


@pytest.mark.skipif(os.name != "nt", reason="需要 Windows 目录联接")
@pytest.mark.parametrize("layout", ["movie", _PREFIX, "ancestor", f"{_PREFIX}00001.tga"])
def test_windows_junction_is_skipped(tmp_path, layout):
    root = tmp_path / "root"
    root.mkdir()
    external = tmp_path / "other"
    outside = _files(
        external,
        [f"{_PREFIX}00000.tga", f"{_PREFIX}.wav", "00000.tga", "audio.wav", "sub/00000.tga"],
    )
    link = root / layout
    # PowerShell 仅创建测试联接，路径通过环境变量传入。
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "New-Item -ItemType Junction -Path $env:WB_NATIVE_TEST_LINK "
            "-Target $env:WB_NATIVE_TEST_TARGET -ErrorAction Stop | Out-Null",
        ],
        env={
            **os.environ,
            "WB_NATIVE_TEST_LINK": str(link),
            "WB_NATIVE_TEST_TARGET": str(external),
        },
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip("当前测试文件系统不支持目录联接")
    try:
        assert link.is_junction()
        roots = [link / "sub"] if layout == "ancestor" else [root]
        assert native_outputs(roots, _PREFIX) == set()
        cleanup_native_outputs(roots, _PREFIX)
        assert link.is_junction()
        assert all(path.read_bytes() == b"fixture" for path in outside)
    finally:
        link.rmdir()


def test_symbolic_link_file_is_skipped(tmp_path):
    target = tmp_path / "preserve.tga"
    target.write_bytes(b"fixture")
    link = tmp_path / f"{_PREFIX}00010.tga"
    try:
        link.symlink_to(target)
    except OSError as error:
        if error.errno != errno.EACCES and getattr(error, "winerror", None) != 1314:
            raise
        pytest.skip("当前环境无法创建符号链接")
    assert native_outputs([tmp_path], _PREFIX) == set()
    cleanup_native_outputs([tmp_path], _PREFIX)
    assert link.is_symlink()
    assert target.read_bytes() == b"fixture"


@pytest.mark.skipif(os.name != "nt", reason="需要 Windows 文件共享模式")
def test_windows_cannot_replace_a_directory_during_cleanup(tmp_path, monkeypatch):
    root = tmp_path / "safe"
    file = next(iter(_files(root, [f"{_PREFIX}00000.tga"])))
    check_file = native_capture._check_file
    checked = []

    def check_while_directory_is_open(directory, name, *, remove):
        with pytest.raises(PermissionError):
            root.rename(tmp_path / "renamed")
        checked.append(name)
        return check_file(directory, name, remove=remove)

    monkeypatch.setattr(native_capture, "_check_file", check_while_directory_is_open)
    cleanup_native_outputs([root], _PREFIX)
    assert checked == [file.name]
    assert not file.exists()


@pytest.mark.skipif(os.name != "nt", reason="需要 Windows 长路径形式")
def test_windows_long_capture_paths_are_discovered_and_cleaned(tmp_path):
    root = tmp_path / ("a" * 95) / ("b" * 95) / ("c" * 95)
    extended = Path("\\\\?\\" + str(root))
    relative = Path("movie") / _PREFIX / "00000.tga"
    owned = extended / relative
    try:
        owned.parent.mkdir(parents=True)
        owned.write_bytes(b"fixture")
        assert native_outputs([root], _PREFIX) == {root / relative}
        cleanup_native_outputs([root], _PREFIX)
        assert not owned.exists()
    finally:
        owned.unlink(missing_ok=True)
        for directory in (owned.parent, owned.parent.parent, extended, *extended.parents[:2]):
            directory.rmdir()
