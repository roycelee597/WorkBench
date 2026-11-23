import ctypes
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager, nullcontext
from ctypes import wintypes
from uuid import uuid4

import pytest

from cs2_engine.windows_job import WindowsJob

pytestmark = pytest.mark.skipif(os.name != "nt", reason="需要 Windows Job Object")

_TREE = """
from pathlib import Path
import subprocess
import sys
import time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(25)"])
Path(sys.argv[1]).write_text(f"{child.pid}\\n", encoding="ascii")
time.sleep(25)
"""


def _fetch_pid(marker):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if marker.exists():
            recorded = marker.read_text(encoding="ascii")
            if recorded.endswith("\n"):
                return int(recorded)
        time.sleep(0.02)
    pytest.fail("测试子进程未写出 PID")


@contextmanager
def _wait_for_pid(pid):
    # 用此进程的句柄检查退出，避免单凭一个可能被复用的 PID 作判断。
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    synchronize = 0x00100000
    handle = kernel.OpenProcess(synchronize, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield lambda milliseconds: kernel.WaitForSingleObject(handle, milliseconds)
    finally:
        assert kernel.CloseHandle(handle)


def _assert_empty(job):
    deadline = time.monotonic() + 3
    while job.active_processes() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert job.active_processes() == 0


@pytest.mark.parametrize("stop", ["terminate", "close"])
def test_stop_ends_child_and_grandchild(tmp_path, stop):
    marker = tmp_path / "grandchild.txt"
    with WindowsJob() as job:
        assert job.active_processes() == 0
        process = job.start([sys.executable, "-c", _TREE, str(marker)], cwd=tmp_path)
        assert process.pid > 0
        grandchild = _fetch_pid(marker)
        assert job.active_processes() >= 2
        assert process.poll() is None
        with pytest.raises(subprocess.TimeoutExpired):
            process.wait(timeout=0.01)
        with _wait_for_pid(grandchild) as wait:
            assert wait(0) == 258
            getattr(job, stop)()
            process.wait(timeout=5)
            assert wait(5000) == 0
        if stop == "terminate":
            _assert_empty(job)


@pytest.mark.parametrize("observe_job", [False, True])
def test_hard_owner_exit_ends_its_job_without_python_cleanup(tmp_path, observe_job):
    marker = tmp_path / "descendant.txt"
    name = f"WorkBenchCS2Test-{uuid4().hex}" if observe_job else ""
    owner_code = """
from pathlib import Path
import sys
import time
from cs2_engine.windows_job import WindowsJob

job = WindowsJob(sys.argv[3] or None)
process = job.start([sys.executable, "-c", sys.argv[1], sys.argv[2]], cwd=Path(sys.argv[2]).parent)
time.sleep(25)
"""
    with subprocess.Popen(
        [sys.executable, "-c", owner_code, _TREE, str(marker), name],
        cwd=tmp_path,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ) as owner:
        try:
            grandchild = _fetch_pid(marker)
            observer = WindowsJob.open_existing(name) if observe_job else nullcontext()
            with observer as monitor, _wait_for_pid(grandchild) as wait:
                assert wait(0) == 258
                owner.kill()
                assert owner.wait(timeout=5) != 0
                if monitor is not None:
                    # 看护进程持有最后一个句柄，需要在恢复文件前主动终止录制。
                    assert wait(0) == 258
                    monitor.terminate()
                assert wait(5000) == 0
                if monitor is not None:
                    _assert_empty(monitor)
        finally:
            if owner.poll() is None:
                owner.kill()


def test_named_job_can_be_observed_and_terminated(tmp_path):
    name = f"WorkBenchCS2Test-{uuid4().hex}"
    with pytest.raises(FileNotFoundError):
        WindowsJob.open_existing(name)
    with WindowsJob(name=name) as job, WindowsJob.open_existing(name) as monitor:
        with pytest.raises(FileExistsError):
            WindowsJob(name=name)
        with pytest.raises(ValueError, match="不允许"):
            monitor.start([sys.executable], cwd=tmp_path)
        process = job.start([sys.executable, "-c", "import time; time.sleep(25)"], cwd=tmp_path)
        assert monitor.active_processes() >= 1
        monitor.terminate()
        assert process.wait(timeout=5) != 0
    with pytest.raises(FileNotFoundError):
        WindowsJob.open_existing(name)


def test_launch_preserves_literal_args_and_cwd_and_discards_streams(tmp_path, capfd):
    marker = tmp_path / "结果.json"
    quoted = '值 "空格" 路径\\'
    code = """
from pathlib import Path
import json
import os
import sys
assert sys.stdin.read() == ""
print("测试 stdout")
print("测试 stderr", file=sys.stderr)
Path(sys.argv[1]).write_text(json.dumps([sys.argv[2], os.getcwd(), os.environ["WB_JOB_TEST"]]))
"""
    with WindowsJob() as job:
        process = job.start(
            [sys.executable, "-c", code, str(marker), quoted],
            cwd=tmp_path,
            env={**os.environ, "WB_JOB_TEST": "自定义环境"},
        )
        assert process.wait(timeout=5) == 0
        assert process.poll() == 0
    assert json.loads(marker.read_text(encoding="ascii")) == [
        quoted,
        str(tmp_path),
        "自定义环境",
    ]
    assert capfd.readouterr() == ("", "")


def test_missing_executable_leaves_job_empty_and_reports_winerror(tmp_path):
    with WindowsJob() as job:
        with pytest.raises(FileNotFoundError) as error:
            job.start([str(tmp_path / "missing.exe")], cwd=tmp_path)
        assert error.value.winerror == 2
        assert job.active_processes() == 0
