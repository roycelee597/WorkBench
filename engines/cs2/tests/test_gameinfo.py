import errno
import json
import os
import subprocess
import sys
from contextlib import suppress
from pathlib import Path
from time import monotonic, sleep

import pytest

from cs2_engine import __main__ as cli
from cs2_engine import gameinfo, recording
from cs2_engine.gameinfo import (
    GameInfoError,
    GameInfoProtection,
    native_prefix_for_job,
    new_recording_job_name,
    recover_gameinfo,
)
from cs2_engine.windows_job import WindowsJob

_ORIGINAL = b"GameInfo\r\n{\r\n}\r\n"

_ABORTED_ENGINE = """
import os
import sys
from pathlib import Path
from cs2_engine.gameinfo import GameInfoProtection

target, state = map(Path, sys.argv[1:])
with GameInfoProtection(target, state):
    os._exit(0)
"""

_ABORTED_NATIVE_ENGINE = """
import os
import sys
from pathlib import Path
from cs2_engine.gameinfo import GameInfoProtection

target, state, profile = map(Path, sys.argv[1:4])
with GameInfoProtection(target, state, job_name=sys.argv[4], native_profile=profile):
    os._exit(0)
"""

_WATCHDOG = """
import argparse
import sys
from pathlib import Path
from cs2_engine.gameinfo import run_gameinfo_watchdog

assert sys.argv[1] == 'gameinfo-watchdog'
parser = argparse.ArgumentParser()
parser.add_argument('--gameinfo', type=Path)
parser.add_argument('--state-dir', type=Path)
parser.add_argument('--job-name')
args = parser.parse_args(sys.argv[2:])
raise SystemExit(run_gameinfo_watchdog(args.gameinfo, args.state_dir, args.job_name))
"""

_ABORTED_ENGINE_WITH_JOB = """
import os
import sys
from pathlib import Path
from time import monotonic, sleep
from cs2_engine.gameinfo import GameInfoProtection
from cs2_engine.windows_job import WindowsJob

target, state, profile, native_output, created = map(Path, sys.argv[1:6])
name, watchdog = sys.argv[6:]
fake_game = '''import sys, time
from pathlib import Path
Path(sys.argv[1]).write_bytes(b"synthetic frames")
Path(sys.argv[2]).touch()
time.sleep(30)
'''
with WindowsJob(name) as job, GameInfoProtection(
    target, state, (sys.executable, "-c", watchdog), job_name=name, native_profile=profile
):
    child = job.start([sys.executable, "-c", fake_game, str(native_output), str(created)],
                      cwd=target.parent)
    deadline = monotonic() + 5
    while not created.exists():
        if child.poll() is not None or monotonic() >= deadline:
            raise SystemExit(2)
        sleep(0.02)
    os._exit(0)
"""


@pytest.fixture
def install(tmp_path: Path) -> tuple[Path, Path]:
    target = tmp_path / "安装目录" / "game" / "csgo" / "gameinfo.gi"
    target.parent.mkdir(parents=True)
    target.write_bytes(_ORIGINAL)
    return target, tmp_path / "恢复目录"


def _run_script(code: str, *args: str | Path) -> None:
    subprocess.run(
        [sys.executable, "-c", code, *(str(arg) for arg in args)],
        check=True,
        capture_output=True,
        timeout=20,
    )


def test_verifies_unchanged_gameinfo_even_if_recording_fails(install):
    target, state = install

    with pytest.raises(ValueError, match="synthetic"):
        with GameInfoProtection(target, state):
            [backup] = state.glob("*/original.gi")
            assert backup.read_bytes() == _ORIGINAL
            raise ValueError("synthetic")

    assert target.read_bytes() == _ORIGINAL
    assert list(state.glob("*/original.gi")) == []
    assert recover_gameinfo(target, state) is False


def test_does_not_replace_unchanged_gameinfo(install, monkeypatch):
    target, state = install
    replace = gameinfo._replace_file

    def only_state_files(source: Path, destination: Path) -> None:
        assert destination != target
        replace(source, destination)

    monkeypatch.setattr(gameinfo, "_replace_file", only_state_files)
    with GameInfoProtection(target, state):
        assert target.read_bytes() == _ORIGINAL
        [journal_path] = state.glob("*/journal.json")
        journal = json.loads(journal_path.read_bytes())
        assert journal["version"] == 2
        assert journal["sha256"] == gameinfo.sha256(_ORIGINAL).hexdigest()
        assert journal["size_bytes"] == len(_ORIGINAL)
        assert journal["mtime_ns"] == target.stat().st_mtime_ns


def test_excludes_concurrent_recording_and_recovery_for_same_install(install):
    target, state = install
    alternate_path = target.parent / ".." / target.parent.name / target.name
    other_target = target.parent.parent / "another" / target.name
    other_target.parent.mkdir()
    other_target.write_bytes(_ORIGINAL)

    with GameInfoProtection(target, state):
        with pytest.raises(GameInfoError, match="已有录制或恢复任务"):
            with GameInfoProtection(alternate_path, state):
                pytest.fail("duplicate recording acquired the installation lock")
        with pytest.raises(GameInfoError, match="已有录制或恢复任务"):
            recover_gameinfo(alternate_path, state)
        with GameInfoProtection(other_target, state):
            assert other_target.read_bytes() == _ORIGINAL


@pytest.mark.parametrize("automatic", [False, True])
def test_recovers_durable_journal_when_engine_and_watchdog_are_gone(install, automatic):
    target, state = install
    _run_script(_ABORTED_ENGINE, target, state)
    assert target.read_bytes() == _ORIGINAL

    if automatic:
        with GameInfoProtection(target, state):
            assert target.read_bytes() == _ORIGINAL
    else:
        assert recover_gameinfo(target, state) is True

    assert target.read_bytes() == _ORIGINAL
    assert recover_gameinfo(target, state) is False


def test_failed_verification_completion_keeps_backup_and_can_retry(install, monkeypatch):
    target, state = install
    replace = gameinfo._replace_file

    def blocked_journal(source: Path, destination: Path) -> None:
        if destination.name == "journal.json" and not json.loads(source.read_bytes())["active"]:
            raise PermissionError(errno.EACCES, "synthetic")
        replace(source, destination)

    with monkeypatch.context() as patch:
        patch.setattr(gameinfo, "_replace_file", blocked_journal)
        with pytest.raises(GameInfoError, match="已保留恢复记录和备份"):
            with GameInfoProtection(target, state):
                assert target.read_bytes() == _ORIGINAL

    [backup] = state.glob("*/original.gi")
    assert backup.read_bytes() == _ORIGINAL
    assert recover_gameinfo(target, state) is True
    assert target.read_bytes() == _ORIGINAL


def test_completed_journal_cannot_restore_old_bytes_after_cleanup_failure(install, monkeypatch):
    target, state = install
    unlink = Path.unlink

    def interrupted_cleanup(path: Path, *args, **kwargs) -> None:
        if path.name in {"original.gi", "journal.json"}:
            raise PermissionError(errno.EACCES, "synthetic")
        unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupted_cleanup)
        with GameInfoProtection(target, state):
            assert target.read_bytes() == _ORIGINAL

    [journal] = state.glob("*/journal.json")
    assert json.loads(journal.read_bytes())["active"] is False
    target.write_bytes(b"later external update")
    assert recover_gameinfo(target, state) is False
    assert target.read_bytes() == b"later external update"


def test_invalid_backup_hash_preserves_target_and_recovery_record(install):
    target, state = install
    _run_script(_ABORTED_ENGINE, target, state)
    [backup] = state.glob("*/original.gi")
    backup.write_bytes(b"invalid")

    with pytest.raises(GameInfoError, match="SHA-256"):
        recover_gameinfo(target, state)

    assert target.read_bytes() == _ORIGINAL
    assert len(list(state.glob("*/journal.json"))) == 1
    assert backup.read_bytes() == b"invalid"


@pytest.mark.parametrize("legacy", [False, True])
def test_recover_cli_keeps_steam_update_and_reports_gameinfo_failed(
    install, monkeypatch, capsys, legacy
):
    target, state = install
    _run_script(_ABORTED_ENGINE, target, state)
    [journal] = state.glob("*/journal.json")
    [backup] = state.glob("*/original.gi")
    if legacy:
        record = json.loads(journal.read_bytes())
        record["version"] = 1
        for key in ("native_profile", "size_bytes", "mtime_ns"):
            record.pop(key)
        journal.write_text(json.dumps(record), encoding="utf-8")

    snapshot = target.stat()
    newer = b"X" * len(_ORIGINAL)
    replacement = target.with_name("steam-update.gi")
    replacement.write_bytes(newer)
    os.utime(replacement, ns=(snapshot.st_atime_ns, snapshot.st_mtime_ns))
    replacement.replace(target)
    game = target.parents[2]
    exe = game / "game" / "bin" / "win64" / "cs2.exe"
    exe.parent.mkdir(parents=True)
    exe.touch()
    monkeypatch.setattr(recording, "_recovery_dir", lambda: state)

    assert cli.main(["recover-gameinfo", "--cs2-path", str(game)]) == 1
    error = json.loads(capsys.readouterr().out)
    assert error["code"] == "GAMEINFO_FAILED"
    assert "验证游戏文件完整性" in error["message"]
    assert target.read_bytes() == newer
    assert backup.read_bytes() == _ORIGINAL
    assert json.loads(journal.read_bytes())["active"] is True


def test_recovery_does_not_recreate_missing_gameinfo(install):
    target, state = install
    _run_script(_ABORTED_ENGINE, target, state)
    target.unlink()

    with pytest.raises(GameInfoError, match="验证游戏文件完整性"):
        recover_gameinfo(target, state)

    assert not target.exists()
    assert list(state.glob("*/original.gi"))


@pytest.mark.parametrize("updated", [False, True])
def test_manual_recovery_cleans_only_registered_native_files(install, tmp_path, updated):
    target, state = install
    profile = tmp_path / "workbench-cs2-testing" / "startmovie" / "profile"
    name = new_recording_job_name()
    prefix = native_prefix_for_job(name)
    locations = (target.parent / "movie", target.parent.parent / "bin" / "win64", profile)
    for directory in locations:
        directory.mkdir(parents=True)
    outputs = [locations[0] / f"{prefix}.wav", locations[1] / f"{prefix}00001.tga"]
    owned_directory = profile / prefix
    owned_directory.mkdir()
    outputs.append(owned_directory / "00002.tga")
    other_session = locations[0] / f"wbp2_{'0' * 32}.wav"
    for file in [*outputs, other_session]:
        file.touch()
    _run_script(_ABORTED_NATIVE_ENGINE, target, state, profile, name)

    if updated:
        target.write_bytes(b"steam update")
        with pytest.raises(GameInfoError, match="验证游戏文件完整性"):
            recover_gameinfo(target, state)
        assert target.read_bytes() == b"steam update"
        assert list(state.glob("*/original.gi"))
    else:
        assert recover_gameinfo(target, state) is True

    assert all(not file.exists() for file in outputs)
    assert other_session.exists()


def test_aborts_start_if_watchdog_exits_before_acknowledgement(install):
    target, state = install
    worker = (sys.executable, "-c", "raise SystemExit(2)")

    with pytest.raises(GameInfoError, match="守护进程未就绪"):
        with GameInfoProtection(target, state, worker):
            pytest.fail("recording was enabled without a watchdog")

    assert target.read_bytes() == _ORIGINAL
    assert recover_gameinfo(target, state) is False


@pytest.mark.skipif(os.name != "nt", reason="需要 Windows Job Object")
def test_watchdog_stops_named_job_and_cleans_native_capture_after_engine_crashes(install, tmp_path):
    target, state = install
    created = tmp_path / "created"
    name = new_recording_job_name()
    profile = tmp_path / "workbench-cs2-testing" / "startmovie" / "profile"
    profile.mkdir(parents=True)
    output = profile / (native_prefix_for_job(name) + "00000.tga")
    _run_script(_ABORTED_ENGINE_WITH_JOB, target, state, profile, output, created, name, _WATCHDOG)
    assert created.exists()

    deadline = monotonic() + 10
    while (target.read_bytes() != _ORIGINAL or list(state.glob("*/journal.json"))) and (
        monotonic() < deadline
    ):
        sleep(0.03)
    assert not output.exists()
    assert target.read_bytes() == _ORIGINAL
    assert list(state.glob("*/journal.json")) == []
    with suppress(FileNotFoundError), WindowsJob.open_existing(name) as job:
        assert job.active_processes() == 0
