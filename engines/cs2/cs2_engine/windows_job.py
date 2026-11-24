import ctypes
import os
import subprocess
import weakref
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from ctypes import wintypes
from math import ceil
from pathlib import Path
from types import TracebackType
from typing import Self

_JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JOB_OBJECT_QUERY = 0x0004
_JOB_OBJECT_TERMINATE = 0x0008
_ERROR_ALREADY_EXISTS = 183

_PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
_PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D
_EXTENDED_STARTUPINFO_PRESENT = 0x00080000
_CREATE_UNICODE_ENVIRONMENT = 0x00000400
_CREATE_NO_WINDOW = 0x08000000
_STARTF_USESTDHANDLES = 0x00000100
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 258
_INFINITE = 0xFFFFFFFF


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IOCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IOCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _BasicAccountingInformation(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_longlong),
        ("TotalKernelTime", ctypes.c_longlong),
        ("ThisPeriodTotalUserTime", ctypes.c_longlong),
        ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


class _StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", wintypes.LPBYTE),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class _StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", _StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class _ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class _Win32:
    def __init__(self) -> None:
        if os.name != "nt":
            raise OSError("录制子进程需要 Windows")
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)

        def bind(name, result, *args):
            function = getattr(kernel, name)
            function.restype = result
            function.argtypes = args
            return function

        boolean = wintypes.BOOL
        dword = wintypes.DWORD
        handle = wintypes.HANDLE
        pointer = ctypes.c_void_p
        text = wintypes.LPCWSTR
        self.close_handle = bind("CloseHandle", boolean, handle)
        self.create_job = bind("CreateJobObjectW", handle, pointer, text)
        self.open_job = bind("OpenJobObjectW", handle, dword, boolean, text)
        self.set_job = bind(
            "SetInformationJobObject", boolean, handle, ctypes.c_int, pointer, dword
        )
        self.query_job = bind(
            "QueryInformationJobObject", boolean, handle, ctypes.c_int, pointer, dword, pointer
        )
        self.terminate_job = bind("TerminateJobObject", boolean, handle, wintypes.UINT)
        self.init_attributes = bind(
            "InitializeProcThreadAttributeList",
            boolean,
            pointer,
            dword,
            dword,
            ctypes.POINTER(ctypes.c_size_t),
        )
        self.update_attribute = bind(
            "UpdateProcThreadAttribute",
            boolean,
            pointer,
            dword,
            ctypes.c_size_t,
            pointer,
            ctypes.c_size_t,
            pointer,
            pointer,
        )
        self.delete_attributes = bind("DeleteProcThreadAttributeList", None, pointer)
        self.create_process = bind(
            "CreateProcessW",
            boolean,
            text,
            ctypes.POINTER(ctypes.c_wchar),
            pointer,
            pointer,
            boolean,
            dword,
            pointer,
            text,
            ctypes.POINTER(_StartupInfoEx),
            ctypes.POINTER(_ProcessInformation),
        )
        self.wait = bind("WaitForSingleObject", dword, handle, dword)
        self.exit_code = bind("GetExitCodeProcess", boolean, handle, ctypes.POINTER(dword))


def _check(result):
    if not result:
        # use_last_error 将 Win32 错误码保存在 ctypes 的线程局部存储中。
        raise ctypes.WinError(ctypes.get_last_error())
    return result


class _Handle:
    def __init__(self, api: _Win32, value: int) -> None:
        self._value = value
        self._release = weakref.finalize(self, api.close_handle, value)

    @property
    def value(self) -> int:
        if not self._release.alive:
            raise ValueError("Windows 句柄已关闭")
        return self._value

    def close(self) -> None:
        if self._release.alive:
            _check(self._release())


@contextmanager
def _process_attributes(api: _Win32, job: int, null: int) -> Iterator[int]:
    size = ctypes.c_size_t()
    api.init_attributes(None, 2, 0, ctypes.byref(size))
    if not size.value:
        raise ctypes.WinError(ctypes.get_last_error())
    # Windows 会就地写入这块缓冲区，使用指针大小的元素保证对齐。
    word_size = ctypes.sizeof(ctypes.c_size_t)
    storage = (ctypes.c_size_t * ((size.value + word_size - 1) // word_size))()
    attributes = ctypes.addressof(storage)
    _check(api.init_attributes(attributes, 2, 0, ctypes.byref(size)))
    std_handles = (wintypes.HANDLE * 1)(null)
    job_handles = (wintypes.HANDLE * 1)(job)
    try:
        _check(
            api.update_attribute(
                attributes,
                0,
                _PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                std_handles,
                ctypes.sizeof(std_handles),
                None,
                None,
            )
        )
        # Windows 在 CreateProcessW 内完成 Job 归属，避免引擎先退出时留下尚未归属的进程。
        _check(
            api.update_attribute(
                attributes,
                0,
                _PROC_THREAD_ATTRIBUTE_JOB_LIST,
                job_handles,
                ctypes.sizeof(job_handles),
                None,
                None,
            )
        )
        yield attributes
    finally:
        api.delete_attributes(attributes)


def _environment_block(env: Mapping[str, str] | None):
    if env is None:
        return None
    pairs = {}
    for key, value in env.items():
        if not key or "=" in key or "\0" in key or "\0" in value:
            raise ValueError("子进程环境变量格式无效")
        pairs[key.upper()] = f"{key}={value}"
    # CreateProcessW 要求环境项按名称排序，末尾有两个 NUL。
    block = "\0".join(pairs[key] for key in sorted(pairs)) + "\0"
    return ctypes.create_unicode_buffer(block)


class WindowsProcess:
    def __init__(self, api: _Win32, handle: _Handle, pid: int) -> None:
        self._api = api
        self._handle = handle
        self._returncode: int | None = None
        self.pid = pid

    def _wait(self, milliseconds: int) -> int | None:
        if self._returncode is not None:
            return self._returncode
        handle = self._handle.value
        result = self._api.wait(handle, milliseconds)
        if result == _WAIT_TIMEOUT:
            return None
        if result != _WAIT_OBJECT_0:
            raise ctypes.WinError(ctypes.get_last_error())
        code = wintypes.DWORD()
        _check(self._api.exit_code(handle, ctypes.byref(code)))
        self._returncode = code.value
        self._handle.close()
        return self._returncode

    def poll(self) -> int | None:
        return self._wait(0)

    def wait(self, timeout: float | None = None) -> int:
        if timeout is None:
            milliseconds = _INFINITE
        else:
            milliseconds = ceil(min(max(timeout, 0) * 1000, _INFINITE - 1))
        code = self._wait(milliseconds)
        if code is None:
            raise subprocess.TimeoutExpired("CS2 录制子进程", timeout)
        return code


class WindowsJob:
    def __init__(self, name: str | None = None) -> None:
        self._api = _Win32()
        ctypes.set_last_error(0)
        value = _check(self._api.create_job(None, name))
        error = ctypes.get_last_error()
        self._handle = _Handle(self._api, value)
        self._can_start = True
        try:
            if error == _ERROR_ALREADY_EXISTS:
                raise ctypes.WinError(error)
            limits = _ExtendedLimitInformation()
            limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            _check(
                self._api.set_job(
                    self._handle.value,
                    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    ctypes.byref(limits),
                    ctypes.sizeof(limits),
                )
            )
        except BaseException:
            self.close()
            raise

    @classmethod
    def open_existing(cls, name: str) -> Self:
        job = cls.__new__(cls)
        job._api = _Win32()
        value = _check(job._api.open_job(_JOB_OBJECT_QUERY | _JOB_OBJECT_TERMINATE, False, name))
        job._handle = _Handle(job._api, value)
        job._can_start = False
        return job

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        _exception_type: type[BaseException] | None,
        _exception: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        self._handle.close()

    def terminate(self) -> None:
        _check(self._api.terminate_job(self._handle.value, 1))
        self._can_start = False

    def active_processes(self) -> int:
        accounting = _BasicAccountingInformation()
        _check(
            self._api.query_job(
                self._handle.value,
                _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                ctypes.byref(accounting),
                ctypes.sizeof(accounting),
                None,
            )
        )
        return accounting.ActiveProcesses

    def start(
        self, argv: Sequence[str], *, cwd: Path, env: Mapping[str, str] | None = None
    ) -> WindowsProcess:
        import msvcrt

        if not self._can_start:
            raise ValueError("当前 Windows Job 不允许启动子进程")
        job = self._handle.value
        if not argv or not Path(argv[0]).is_absolute() or any("\0" in arg for arg in argv):
            raise ValueError("子进程需要有效的可执行文件绝对路径和参数")
        if not cwd.is_absolute() or "\0" in str(cwd):
            raise ValueError("子进程需要有效的工作目录绝对路径")
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        environment = _environment_block(env)
        process = _ProcessInformation()
        startup = _StartupInfoEx()
        startup.StartupInfo.cb = ctypes.sizeof(_StartupInfoEx)
        startup.StartupInfo.dwFlags = _STARTF_USESTDHANDLES
        flags = _EXTENDED_STARTUPINFO_PRESENT | _CREATE_UNICODE_ENVIRONMENT | _CREATE_NO_WINDOW

        with open(os.devnull, "r+b", buffering=0) as stream:
            null = msvcrt.get_osfhandle(stream.fileno())
            os.set_handle_inheritable(null, True)
            startup.StartupInfo.hStdInput = null
            startup.StartupInfo.hStdOutput = null
            startup.StartupInfo.hStdError = null
            with _process_attributes(self._api, job, null) as attributes:
                startup.lpAttributeList = attributes
                _check(
                    self._api.create_process(
                        argv[0],
                        command_line,
                        None,
                        None,
                        True,
                        flags,
                        environment,
                        str(cwd),
                        ctypes.byref(startup),
                        ctypes.byref(process),
                    )
                )
        handle = _Handle(self._api, process.hProcess)
        _check(self._api.close_handle(process.hThread))
        return WindowsProcess(self._api, handle, process.dwProcessId)
