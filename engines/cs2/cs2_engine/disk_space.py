from collections.abc import Iterable
from math import ceil
from pathlib import Path
from shutil import disk_usage

from .record_task import RecordError

_BYTES_PER_GB = 1_000_000_000
_MP4_BYTES_PER_SECOND = 30_000_000
_PCM_BYTES_PER_SECOND = 48_000 * 2 * 2
_PROFILE_BYTES = 64 * 1024**2
_MIN_MARGIN_BYTES = 256 * 1024**2


def raw_bytes(duration: float, capture_size: tuple[int, int]) -> int:
    """按 32 位 TGA、60 fps 预留原始图像和 WAV 的空间。"""
    width, height = capture_size
    # HLAE 2.193.2 的 1080p60 实测为 373.43 MB/s。以 366 张 24 位 TGA 和 WAV
    # 的文件大小之和 2,277,894,632 字节，除以 366 / 60 秒。预算按 32 位 TGA 上限预留。
    # 包含起止 tick 的三帧容差、TGA 文件头、磁盘分配开销和 WAV。
    return (ceil(duration * 60) + 3) * (width * height * 4 + 4096) + ceil(duration * 1_000_000)


def _find_volume(path: Path) -> tuple[int | str, str, Path]:
    existing = path.resolve()
    while True:
        try:
            device = existing.stat().st_dev
            break
        except FileNotFoundError:
            if existing.parent == existing:
                raise
            existing = existing.parent

    root = existing
    # st_dev 可合并指向同一卷的目录，盘符下挂载的其他卷单独核算。
    for parent in existing.parents:
        try:
            if parent.stat().st_dev != device:
                break
        except OSError:
            break
        root = parent
    name = str(root).rstrip("\\/") or str(root)
    return device or existing.anchor.casefold(), name, existing


def _shortage(label: str, path: Path, needed: int) -> str | None:
    available = disk_usage(path).free
    if available < needed:
        return (
            f"{label} 需要约 {needed / _BYTES_PER_GB:.2f} GB，"
            f"可用 {available / _BYTES_PER_GB:.2f} GB，"
            f"还差 {(needed - available) / _BYTES_PER_GB:.2f} GB。"
        )
    return None


def require_free_space(path: Path, needed: int) -> None:
    """检查当前路径所在的卷，路径尚未创建时检查已有的上级目录。"""
    try:
        _, label, existing = _find_volume(path)
        if shortage := _shortage(label, existing, needed):
            raise RecordError("OUTPUT_WRITE_FAILED", shortage)
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法查询录制磁盘的可用空间。") from None


def check_recording_space(
    output_dir: Path,
    work_dir: Path,
    durations: Iterable[float],
    *,
    capture_size: tuple[int, int],
    demo_bytes: int,
    keep_raw: bool = False,
    compilation: bool = True,
    native_dir: Path | None = None,
) -> None:
    """检查成品、录制和合成所需空间。同一卷统一核算。"""
    clips = tuple(durations)
    if not clips:
        return

    total_seconds = sum(clips)
    total_mp4 = ceil(total_seconds * _MP4_BYTES_PER_SECOND)
    largest_mp4 = ceil(max(clips) * _MP4_BYTES_PER_SECOND)
    raw_clips = [raw_bytes(duration, capture_size) for duration in clips]
    largest_raw = max(raw_clips)
    retained_raw = sum(raw_clips) if keep_raw else 0
    # 成品预算包含单段、两种视角合集和汇总空间。合成时只有一个合集的中间文件。
    output_bytes = total_mp4 * (2 if compilation else 1) + 1024**2 + len(clips) * 2048
    # HLAE 在工作卷写 TGA。startmovie 可能先写在安装卷，再把需要保留的文件搬入工作卷。
    live_raw = retained_raw or (largest_raw if native_dir is None else 0)
    capture_workspace = live_raw + largest_mp4
    compose_workspace = (
        retained_raw + 2 * total_mp4 + ceil(total_seconds * _PCM_BYTES_PER_SECOND)
        if compilation
        else 0
    )
    working_bytes = demo_bytes + _PROFILE_BYTES + max(capture_workspace, compose_workspace)

    paths = [(output_dir, output_bytes), (work_dir, working_bytes)]
    if native_dir is not None:
        paths.append((native_dir, largest_raw))
    budgets: dict[int | str, tuple[str, Path, int]] = {}
    try:
        for path, needed in paths:
            key, label, existing = _find_volume(path)
            if key in budgets:
                label, existing, previous = budgets[key]
                needed += previous
            budgets[key] = label, existing, needed

        shortages = []
        for label, existing, needed in budgets.values():
            margin = max(_MIN_MARGIN_BYTES, (needed + 9) // 10)
            if shortage := _shortage(label, existing, needed + margin):
                shortages.append(shortage)
        if shortages:
            raise RecordError("OUTPUT_WRITE_FAILED", " ".join(shortages))
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法查询录制磁盘的可用空间。") from None
