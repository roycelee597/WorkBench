import errno
import json
import os
import subprocess
import sys
from contextlib import suppress
from pathlib import Path
from time import monotonic, sleep

import pytest

from cs2_engine import gameinfo
from cs2_engine.gameinfo import (
    GameInfoError,
    GameInfoProtection,
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
    target.write_bytes(b'temporary')
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

target, state, modified = map(Path, sys.argv[1:4])
name, watchdog = sys.argv[4:]
fake_game = '''import sys, time
from pathlib import Path
Path(sys.argv[1]).write_bytes(b"temporary")
Path(sys.argv[2]).touch()
time.sleep(30)
'''
with WindowsJob(name) as job, GameInfoProtection(
    target, state, (sys.executable, "-c", watchdog), job_name=name
):
    child = job.start([sys.executable, "-c", fake_game, str(target), str(modified)],
                      cwd=target.parent)
    deadline = monotonic() + 5
    while not modified.exists():
        if child.poll() is not None or monotonic() >= deadline:
            raise SystemExit(2)
        sleep(0.02)
    os._exit(0)
"""


@pytest.fixture
def install(tmp_path: Path) -> tuple[Path, Path]:
    target = tmp_path / "游戏目录" / "gameinfo.gi"
    target.parent.mkdir()
    target.write_bytes(_ORIGINAL)
    return target, tmp_path / "恢复目录"


def _run_script(code: str, *args: str | Path) -> None:
    subprocess.run(
        [sys.executable, "-c", code, *(str(arg) for arg in args)],
        check=True,
        capture_output=True,
        timeout=20,
    )


def test_restores_exact_bytes_even_if_recording_fails(install):
    target, state = install

    with pytest.raises(ValueError, match="synthetic"):
        with GameInfoProtection(target, state):
            [backup] = state.glob("*/original.gi")
            assert backup.read_bytes() == _ORIGINAL
            target.unlink()
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
    assert target.read_bytes() == b"temporary"

    if automatic:
        with GameInfoProtection(target, state):
            assert target.read_bytes() == _ORIGINAL
    else:
        assert recover_gameinfo(target, state) is True

    assert target.read_bytes() == _ORIGINAL
    assert recover_gameinfo(target, state) is False


def test_failed_restore_keeps_verified_backup_and_can_retry(install, monkeypatch):
    target, state = install
    replace = gameinfo._replace_file

    def blocked_target(source: Path, destination: Path) -> None:
        if destination == target:
            raise PermissionError(errno.EACCES, "synthetic")
        replace(source, destination)

    with monkeypatch.context() as patch:
        patch.setattr(gameinfo, "_replace_file", blocked_target)
        with pytest.raises(GameInfoError, match="已保留恢复记录和备份"):
            with GameInfoProtection(target, state):
                target.write_bytes(b"temporary")

    [backup] = state.glob("*/original.gi")
    assert backup.read_bytes() == _ORIGINAL
    assert target.read_bytes() == b"temporary"
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
            target.write_bytes(b"temporary")

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

    assert target.read_bytes() == b"temporary"
    assert len(list(state.glob("*/journal.json"))) == 1
    assert backup.read_bytes() == b"invalid"


def test_aborts_start_if_watchdog_exits_before_acknowledgement(install):
    target, state = install
    worker = (sys.executable, "-c", "raise SystemExit(2)")

    with pytest.raises(GameInfoError, match="守护进程未就绪"):
        with GameInfoProtection(target, state, worker):
            pytest.fail("recording was enabled without a watchdog")

    assert target.read_bytes() == _ORIGINAL
    assert recover_gameinfo(target, state) is False


@pytest.mark.skipif(os.name != "nt", reason="需要 Windows Job Object")
def test_watchdog_stops_named_job_and_restores_after_engine_crashes(install, tmp_path):
    target, state = install
    changed = tmp_path / "changed"
    name = new_recording_job_name()
    _run_script(_ABORTED_ENGINE_WITH_JOB, target, state, changed, name, _WATCHDOG)
    assert changed.exists()

    deadline = monotonic() + 10
    while (target.read_bytes() != _ORIGINAL or list(state.glob("*/journal.json"))) and (
        monotonic() < deadline
    ):
        sleep(0.03)
    assert target.read_bytes() == _ORIGINAL
    assert list(state.glob("*/journal.json")) == []
    with suppress(FileNotFoundError), WindowsJob.open_existing(name) as job:
        assert job.active_processes() == 0
