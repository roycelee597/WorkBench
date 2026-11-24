import ctypes
import errno
import os
import re
import stat
from collections.abc import Iterator, Sequence
from contextlib import ExitStack, contextmanager
from ctypes import wintypes
from dataclasses import dataclass
from functools import cache
from pathlib import Path

_SESSION_NAME = re.compile(r"wbp2_[0-9a-f]{32}")
_DIRECTORY = 0x10
_DEVICE = 0x40
_REPARSE_POINT = 0x400
_FILE_LIST_DIRECTORY = 0x01
_FILE_READ_ATTRIBUTES = 0x80
_DELETE = 0x10000
_SHARE_READ = 0x01
_SHARE_WRITE = 0x02
_OPEN_EXISTING = 3
_OPEN_REPARSE_POINT = 0x00200000
_BACKUP_SEMANTICS = 0x02000000
_INVALID_HANDLE = ctypes.c_void_p(-1).value
_FILE_ATTRIBUTE_TAG_INFO = 9
_FILE_DISPOSITION_INFO = 4


class _AttributeTag(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]


@dataclass(frozen=True, slots=True)
class _Directory:
    path: Path
    fd: int | None = None


def valid_native_prefix(value: object) -> bool:
    return isinstance(value, str) and _SESSION_NAME.fullmatch(value) is not None


def _windows_path(path: Path) -> str:
    value = str(path)
    if value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\.\\"):
        raise ValueError("原生录制路径不能使用 Windows 设备名称。")
    if value.startswith("\\\\"):
        return "\\\\?\\UNC\\" + value[2:]
    return "\\\\?\\" + value


@cache
def _windows_api():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    dword = wintypes.DWORD
    handle = wintypes.HANDLE
    pointer = ctypes.c_void_p
    kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, dword, dword, pointer, dword, dword, handle)
    kernel.CreateFileW.restype = handle
    kernel.GetFileInformationByHandleEx.argtypes = (handle, ctypes.c_int, pointer, dword)
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.SetFileInformationByHandle.argtypes = (handle, ctypes.c_int, pointer, dword)
    kernel.SetFileInformationByHandle.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (handle,)
    kernel.CloseHandle.restype = wintypes.BOOL
    return kernel


@contextmanager
def _windows_entry(
    path: Path, *, delete: bool = False, directory: bool = False
) -> Iterator[tuple[int, int] | None]:
    kernel = _windows_api()
    access = _FILE_READ_ATTRIBUTES | (_DELETE if delete else 0)
    share = _SHARE_READ | _SHARE_WRITE
    if directory:
        access |= _FILE_LIST_DIRECTORY
        share = _SHARE_READ
    handle = kernel.CreateFileW(
        _windows_path(path),
        access,
        share,
        None,
        _OPEN_EXISTING,
        _OPEN_REPARSE_POINT | _BACKUP_SEMANTICS,
        None,
    )
    if handle == _INVALID_HANDLE:
        error = ctypes.WinError(ctypes.get_last_error())
        if isinstance(error, FileNotFoundError):
            yield None
            return
        raise error
    try:
        tag = _AttributeTag()
        if not kernel.GetFileInformationByHandleEx(
            handle, _FILE_ATTRIBUTE_TAG_INFO, ctypes.byref(tag), ctypes.sizeof(tag)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        yield handle, tag.attributes
    finally:
        kernel.CloseHandle(handle)


@contextmanager
def _directory(path: Path, parent: _Directory | None) -> Iterator[_Directory | None]:
    if os.name == "nt":
        # 保持每级目录句柄打开，在扫描和清理结束前禁止替换目录。
        with _windows_entry(path, directory=True) as entry:
            if entry is None or entry[1] & _REPARSE_POINT or not entry[1] & _DIRECTORY:
                yield None
            else:
                yield _Directory(path)
        return

    try:
        fd = os.open(
            path if parent is None else path.name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=None if parent is None else parent.fd,
        )
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            raise
        yield None
        return
    try:
        yield _Directory(path, fd)
    finally:
        os.close(fd)


def _check_file(directory: _Directory, name: str, *, remove: bool) -> bool:
    if os.name == "nt":
        with _windows_entry(directory.path / name, delete=remove) as entry:
            if entry is None or entry[1] & (_DIRECTORY | _DEVICE | _REPARSE_POINT):
                return False
            if remove:
                # 路径在核对后可能变化，只删除已打开且核对过的对象。
                disposition = ctypes.c_ubyte(1)
                if not _windows_api().SetFileInformationByHandle(
                    entry[0],
                    _FILE_DISPOSITION_INFO,
                    ctypes.byref(disposition),
                    ctypes.sizeof(disposition),
                ):
                    raise ctypes.WinError(ctypes.get_last_error())
            return True

    try:
        info = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            return False
        if remove:
            os.unlink(name, dir_fd=directory.fd)
    except FileNotFoundError:
        return False
    return True


def _is_capture_name(name: str, prefix: str, *, in_session_directory: bool) -> bool:
    stem, extension = os.path.splitext(name)
    extension = extension.lower()
    if extension == ".wav":
        return stem == prefix or (in_session_directory and stem == "audio")
    if extension != ".tga":
        return False
    if re.fullmatch(rf"{prefix}[._-]?[0-9]+", stem):
        return True
    return in_session_directory and re.fullmatch(r"(?:frame[._-]?)?[0-9]+", stem) is not None


def _scan(
    directory: _Directory, prefix: str, *, remove: bool, in_session_directory: bool = False
) -> Iterator[Path]:
    target = _windows_path(directory.path) if directory.fd is None else directory.fd
    with os.scandir(target) as entries:
        # 删除时使用已读取的名称，避免改变仍在遍历的目录列表。
        names = [entry.name for entry in entries]
    for name in names:
        if not in_session_directory and name == prefix:
            with _directory(directory.path / name, directory) as subdir:
                if subdir is not None:
                    yield from _scan(subdir, prefix, remove=remove, in_session_directory=True)
        elif _is_capture_name(name, prefix, in_session_directory=in_session_directory):
            if _check_file(directory, name, remove=remove):
                yield directory.path / name


def _native_outputs(roots: Sequence[Path], prefix: str, *, remove: bool) -> Iterator[Path]:
    if not valid_native_prefix(prefix):
        raise ValueError("原生录制临时名称无效。")
    for root in roots:
        root = root.absolute()
        if ".." in root.parts:
            raise ValueError("原生录制路径不能包含上级目录。")
        with ExitStack() as stack:
            directory = None
            for path in (*reversed(root.parents), root):
                directory = stack.enter_context(_directory(path, directory))
                if directory is None:
                    break
            if directory is None:
                continue
            yield from _scan(directory, prefix, remove=remove)
            with _directory(root / "movie", directory) as movie:
                if movie is not None:
                    yield from _scan(movie, prefix, remove=remove)


def native_outputs(roots: Sequence[Path], prefix: str) -> set[Path]:
    return set(_native_outputs(roots, prefix, remove=False))


def cleanup_native_outputs(roots: Sequence[Path], prefix: str) -> None:
    for _ in _native_outputs(roots, prefix, remove=True):
        pass
