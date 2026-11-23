from __future__ import annotations

import errno
import json
import os
import subprocess
import sys
from collections.abc import Iterator, Sequence
from contextlib import ExitStack, contextmanager, suppress
from dataclasses import asdict, dataclass, replace
from hashlib import sha256
from pathlib import Path
from queue import Empty, Queue
from tempfile import NamedTemporaryFile
from threading import Thread
from time import monotonic, sleep
from types import TracebackType
from typing import BinaryIO
from uuid import uuid4

from .windows_job import WindowsJob

_POLL_S = 0.05
_JOB_TIMEOUT_S = 10
_WATCHDOG_READY_TIMEOUT_S = 30
_WATCHDOG_LOCK_TIMEOUT_S = 15
_WATCHDOG_READY = b"R"
_JOB_NAME_PREFIX = "Local\\WorkBench-CS2-"


class GameInfoError(RuntimeError):
    """无法安全备份或恢复 gameinfo.gi。"""


@dataclass(frozen=True, slots=True)
class _State:
    target: Path
    directory: Path
    key: str

    @classmethod
    def for_install(cls, target: Path, state_dir: Path) -> _State:
        try:
            target = target.resolve()
            key = sha256(os.path.normcase(str(target)).encode("utf-8")).hexdigest()
            return cls(target, state_dir.resolve() / key, key)
        except (OSError, RuntimeError):
            raise GameInfoError("无法定位 CS2 配置或恢复目录。") from None

    @property
    def backup(self) -> Path:
        return self.directory / "original.gi"

    @property
    def journal(self) -> Path:
        return self.directory / "journal.json"


@dataclass(frozen=True, slots=True)
class _Journal:
    version: int
    install: str
    session: str
    sha256: str
    job_name: str | None
    active: bool = True


def _hex_string(value: object, size: int) -> bool:
    return (
        isinstance(value, str)
        and len(value) == size
        and all(char in "0123456789abcdef" for char in value)
    )


def new_recording_job_name() -> str:
    return _JOB_NAME_PREFIX + uuid4().hex


def _valid_job_name(value: object) -> bool:
    return value is None or (
        isinstance(value, str)
        and value.startswith(_JOB_NAME_PREFIX)
        and _hex_string(value.removeprefix(_JOB_NAME_PREFIX), 32)
    )


def _read_journal(state: _State) -> _Journal | None:
    try:
        record = json.loads(state.journal.read_bytes())
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, ValueError):
        raise GameInfoError("无法读取 CS2 配置恢复记录，已保留备份。") from None
    if (
        not isinstance(record, dict)
        or type(record.get("version")) is not int
        or record.get("version") != 1
        or record.get("install") != state.key
        or not _hex_string(record.get("session"), 32)
        or not _hex_string(record.get("sha256"), 64)
        or not isinstance(record.get("active"), bool)
        or "job_name" not in record
        or not _valid_job_name(record["job_name"])
    ):
        raise GameInfoError("CS2 配置恢复记录校验失败，已保留备份。")
    return _Journal(
        1, state.key, record["session"], record["sha256"], record["job_name"], record["active"]
    )


def _replace_file(source: Path, target: Path) -> None:
    if os.name != "nt":
        os.replace(source, target)
        parent = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        return

    import ctypes
    from ctypes import wintypes

    replace = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
    replace.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
    replace.restype = wintypes.BOOL
    replace_existing = 0x1
    write_through = 0x8
    if not replace(str(source), str(target), replace_existing | write_through):
        raise ctypes.WinError(ctypes.get_last_error())


def _write_atomic(target: Path, data: bytes) -> None:
    temporary: Path | None = None
    try:
        with NamedTemporaryFile(mode="wb", dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        _replace_file(temporary, target)
    finally:
        if temporary is not None:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)


def _try_lock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


@contextmanager
def _installation_lock(state: _State, *, timeout: float = 0) -> Iterator[None]:
    try:
        state.directory.mkdir(parents=True, exist_ok=True)
        lock = (state.directory / "session.lock").open("a+b")
    except OSError:
        raise GameInfoError("无法打开 CS2 配置保护锁。") from None

    with lock:
        deadline = monotonic() + timeout
        lock.seek(0)
        while True:
            try:
                _try_lock(lock.fileno())
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise GameInfoError("无法锁定 CS2 配置恢复目录。") from None
                if monotonic() >= deadline:
                    raise GameInfoError("此 CS2 安装目录已有录制或恢复任务在运行。") from None
                sleep(_POLL_S)
        # 进程终止时，操作系统也会关闭句柄并释放锁。
        yield


def _write_journal(state: _State, journal: _Journal) -> None:
    _write_atomic(state.journal, json.dumps(asdict(journal)).encode("utf-8"))


def _backup(state: _State, job_name: str | None) -> _Journal:
    try:
        original = state.target.read_bytes()
        digest = sha256(original).hexdigest()
        _write_atomic(state.backup, original)
        if sha256(state.backup.read_bytes()).hexdigest() != digest:
            raise GameInfoError("CS2 配置备份的 SHA-256 校验失败。")
        if sha256(state.target.read_bytes()).hexdigest() != digest:
            raise GameInfoError("备份期间 CS2 配置发生变化，无法开始录制。")
        journal = _Journal(1, state.key, uuid4().hex, digest, job_name)
        _write_journal(state, journal)
        return journal
    except OSError:
        raise GameInfoError("无法备份 CS2 配置，录制未启动。") from None


def _open_job(name: str | None) -> WindowsJob | None:
    if name is None:
        return None
    try:
        return WindowsJob.open_existing(name)
    except FileNotFoundError:
        return None
    except (OSError, RuntimeError):
        raise GameInfoError("无法打开原录制进程组，已保留 CS2 配置备份。") from None


def _stop_job(job: WindowsJob | None) -> None:
    if job is None:
        return
    try:
        if job.active_processes() == 0:
            return
        job.terminate()
        deadline = monotonic() + _JOB_TIMEOUT_S
        while job.active_processes() != 0:
            if monotonic() >= deadline:
                raise GameInfoError("录制进程尚未结束，已保留 CS2 配置备份。")
            sleep(_POLL_S)
    except OSError:
        raise GameInfoError("无法确认录制进程结束，已保留 CS2 配置备份。") from None


def _recover_locked(
    state: _State, *, session: str | None = None, job: WindowsJob | None = None
) -> bool:
    journal = _read_journal(state)
    if (
        journal is None
        or not journal.active
        or (session is not None and journal.session != session)
    ):
        return False

    with ExitStack() as stack:
        if job is None and (opened := _open_job(journal.job_name)) is not None:
            job = stack.enter_context(opened)
        _stop_job(job)
        try:
            original = state.backup.read_bytes()
            if sha256(original).hexdigest() != journal.sha256:
                raise GameInfoError("CS2 配置备份的 SHA-256 校验失败，已保留现场。")
            try:
                current = state.target.read_bytes()
            except FileNotFoundError:
                current = None
            if current != original:
                _write_atomic(state.target, original)
            if sha256(state.target.read_bytes()).hexdigest() != journal.sha256:
                raise GameInfoError("CS2 配置恢复后校验失败，已保留备份。")
            # 先持久化完成标记。即使系统在删除记录和备份之间重启，也不会使用旧备份。
            _write_journal(state, replace(journal, active=False))
        except OSError:
            raise GameInfoError("无法恢复 CS2 配置，已保留恢复记录和备份。") from None
        with suppress(OSError):
            state.backup.unlink()
        with suppress(OSError):
            state.journal.unlink()
        return True


def recover_gameinfo(gameinfo_path: Path, state_dir: Path) -> bool:
    """恢复一次未完成的录制会话，返回是否处理了恢复记录。"""
    state = _State.for_install(gameinfo_path, state_dir)
    with _installation_lock(state):
        return _recover_locked(state)


def _read_ready(pipe: BinaryIO, result: Queue[bytes]) -> None:
    try:
        result.put(pipe.read(1))
    except (OSError, ValueError):
        result.put(b"")


class GameInfoProtection:
    """录制期间锁定安装目录，正常退出时恢复配置。"""

    def __init__(
        self,
        gameinfo_path: Path,
        state_dir: Path,
        worker_command: Sequence[str] | None = None,
        *,
        job_name: str | None = None,
    ) -> None:
        if not _valid_job_name(job_name):
            raise GameInfoError("CS2 录制进程组名称无效。")
        self._state = _State.for_install(gameinfo_path, state_dir)
        self._job_name = job_name
        self._worker_command = tuple(worker_command) if worker_command is not None else None
        self._worker: subprocess.Popen[bytes] | None = None
        self._worker_ready = False
        self._scope: ExitStack | None = None

    def _start_watchdog(self, command: tuple[str, ...]) -> None:
        argv = [
            *command,
            "gameinfo-watchdog",
            "--gameinfo",
            str(self._state.target),
            "--state-dir",
            str(self._state.directory.parent),
        ]
        if self._job_name is not None:
            argv.extend(("--job-name", self._job_name))
        # 单文件版守护进程需要独立的解包目录，才能在录制引擎退出后继续恢复。
        env = {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}
        try:
            worker = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                start_new_session=os.name != "nt",
                env=env,
            )
        except OSError:
            raise GameInfoError("无法启动 CS2 配置恢复守护进程。") from None
        self._worker = worker
        assert worker.stdout is not None
        ready: Queue[bytes] = Queue(maxsize=1)
        Thread(target=_read_ready, args=(worker.stdout, ready), daemon=True).start()
        try:
            self._worker_ready = ready.get(timeout=_WATCHDOG_READY_TIMEOUT_S) == _WATCHDOG_READY
        except Empty:
            pass
        if not self._worker_ready:
            raise GameInfoError("CS2 配置恢复守护进程未就绪，录制未启动。")

    def _finish_watchdog(self) -> None:
        worker = self._worker
        if worker is None:
            return
        self._worker = None
        if worker.stdin is not None:
            with suppress(OSError):
                worker.stdin.close()
        self._worker_ready, was_ready = False, self._worker_ready
        if not was_ready:
            with suppress(OSError):
                worker.kill()
        with suppress(OSError, subprocess.TimeoutExpired):
            worker.wait(timeout=_JOB_TIMEOUT_S)
        if worker.stdout is not None and worker.poll() is not None:
            worker.stdout.close()

    def __enter__(self) -> GameInfoProtection:
        if self._scope is not None:
            raise GameInfoError("CS2 配置保护已启用。")
        with ExitStack() as scope:
            scope.callback(self._finish_watchdog)
            scope.enter_context(_installation_lock(self._state))
            _recover_locked(self._state)
            journal = _backup(self._state, self._job_name)
            scope.callback(_recover_locked, self._state, session=journal.session)
            if self._worker_command is not None:
                self._start_watchdog(self._worker_command)
            self._scope = scope.pop_all()
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        scope = self._scope
        self._scope = None
        return scope is not None and scope.__exit__(kind, error, traceback)


def run_gameinfo_watchdog(gameinfo_path: Path, state_dir: Path, job_name: str | None = None) -> int:
    """等待引擎管道断开，停止进程组后恢复对应会话。"""
    try:
        state = _State.for_install(gameinfo_path, state_dir)
        journal = _read_journal(state)
        if journal is None or not journal.active or journal.job_name != job_name:
            return 1
        with ExitStack() as scope:
            job = _open_job(job_name)
            if job_name is not None and job is None:
                return 1
            if job is not None:
                scope.enter_context(job)
            sys.stdout.buffer.write(_WATCHDOG_READY)
            sys.stdout.buffer.flush()
            sys.stdin.buffer.read()
            # 正常退出或其他恢复任务可能已处理本次记录，防止接管后来创建的会话。
            current = _read_journal(state)
            if current is not None and current.active and current.session == journal.session:
                with _installation_lock(state, timeout=_WATCHDOG_LOCK_TIMEOUT_S):
                    _recover_locked(state, session=journal.session, job=job)
        return 0
    except (GameInfoError, OSError):
        return 1
