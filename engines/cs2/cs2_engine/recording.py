import csv
import errno
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
import wave
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .disk_space import check_recording_space, raw_bytes, require_free_space
from .gameinfo import (
    GameInfoProtection,
    native_prefix_for_job,
    new_recording_job_name,
    recover_gameinfo,
)
from .native_capture import native_outputs
from .parser import has_recorded_crosshair
from .record_task import OUTPUT_SIZE, CaptureAspect, RecordError, RecordTask, validate_record_path
from .recording_commands import RecordingMethod, hlae_argv, write_capture_config
from .windows_job import WindowsJob, WindowsProcess


class CaptureIncomplete(RecordError):
    def __init__(self, message: str) -> None:
        super().__init__("RECORD_FAILED", message)


@dataclass(frozen=True, slots=True)
class CaptureTools:
    cs2: Path
    gameinfo: Path
    hlae: Path
    ffmpeg: Path
    ffprobe: Path


@dataclass(frozen=True, slots=True)
class RawCapture:
    pattern: Path
    first_frame: int
    frame_count: int
    audio: Path
    source_size: tuple[int, int]
    tail_padding_frames: int = 0


@dataclass(frozen=True, slots=True)
class RecordedClip:
    output: Path
    method: RecordingMethod
    duration_s: float
    capture_elapsed_s: float
    size_bytes: int
    fallback_reason: str | None = None
    tail_padding_frames: int = 0
    raw_output: Path | None = None
    probe: dict | None = None


def _game_location(cs2: Path) -> tuple[Path, Path]:
    if cs2.is_dir():
        cs2 = validate_record_path(cs2 / "game" / "bin" / "win64" / "cs2.exe")
    if cs2.name.lower() != "cs2.exe" or len(cs2.parents) < 3 or not cs2.is_file():
        raise RecordError("CS2_NOT_FOUND", "找不到 CS2。请在 cs2_path 填写安装目录或 cs2.exe。")
    return cs2, validate_record_path(cs2.parents[2] / "csgo" / "gameinfo.gi")


def _recovery_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        raise RecordError("PERMISSION_DENIED", "无法确定录制原型的独立恢复目录。")
    return validate_record_path(Path(base) / "WorkBench-CS2-Prototype")


def recover_recording(cs2: Path, *, accept_current: bool = False) -> bool:
    _, gameinfo = _game_location(validate_record_path(cs2))
    return recover_gameinfo(gameinfo, _recovery_dir(), accept_current=accept_current)


def _capture_tools(task: RecordTask) -> CaptureTools:
    cs2, gameinfo = _game_location(task.cs2_path)
    hlae = task.hlae_path
    hook = validate_record_path(hlae.parent / "x64" / "AfxHookSource2.dll")
    spec_lock = validate_record_path(
        hlae.parent / "resources" / "AfxHookSource2" / "snippets" / "mirv_script_spec_lock.js"
    )
    if hlae.name.lower() != "hlae.exe" or not all(
        path.is_file() for path in (hlae, hook, spec_lock)
    ):
        raise RecordError(
            "HLAE_NOT_FOUND", "请指定包含 CS2 组件和 mirv_script_spec_lock.js 的完整 HLAE 安装。"
        )
    ffmpeg = task.ffmpeg_path
    ffprobe = validate_record_path(ffmpeg.with_name("ffprobe.exe"))
    if ffmpeg.name.lower() != "ffmpeg.exe" or not ffmpeg.is_file() or not ffprobe.is_file():
        raise RecordError("FFMPEG_FAILED", "请提供与 ffprobe.exe 同目录的 ffmpeg.exe。")
    return CaptureTools(cs2, gameinfo, hlae, ffmpeg, ffprobe)


def _ensure_cs2_closed() -> None:
    system_root = os.environ.get("SystemRoot")
    if not system_root:
        raise RecordError("RECORD_FAILED", "无法检查 CS2 是否已退出。")
    try:
        running = subprocess.run(
            [
                str(Path(system_root) / "System32" / "tasklist.exe"),
                "/FI",
                "IMAGENAME eq cs2.exe",
                "/FO",
                "CSV",
                "/NH",
            ],
            capture_output=True,
            check=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        raise RecordError("RECORD_FAILED", "无法检查 CS2 是否已退出。") from None
    rows = csv.reader(running.stdout.decode("ascii", errors="replace").splitlines())
    if any(row and row[0].lower() == "cs2.exe" for row in rows):
        raise RecordError("RECORD_FAILED", "请先退出正在运行的 CS2，再启动录制。")


def _staging_root(work_dir: Path) -> Path:
    path = validate_record_path(work_dir)
    value = path.as_posix()
    if not value.isascii() or any(ord(char) < 32 or char in '";' for char in value):
        raise RecordError("INVALID_TASK", "录制工作目录需要使用不含引号和分号的 ASCII 路径。")
    return path


def _check_space(path: Path, required: int) -> None:
    require_free_space(path, required)


def _publish_video(source: Path, target: Path) -> None:
    """跨盘时先复制到成品盘的临时文件，再原子发布已校验的视频。"""
    try:
        source.replace(target)
    except OSError as error:
        if error.errno != errno.EXDEV and getattr(error, "winerror", None) != 17:
            raise
        with tempfile.TemporaryDirectory(prefix=".cs2-publish-", dir=target.parent) as transfer:
            local = Path(transfer) / "video.mp4"
            shutil.copyfile(source, local)
            local.replace(target)


def _stage_demo(source: Path, directory: Path, required: int) -> Path:
    try:
        with source.open("rb") as demo:
            if demo.read(8) != b"PBDEMS2\x00":
                raise RecordError("DEMO_PARSE_FAILED", "所选文件不是有效的 CS2 demo。")
        _check_space(directory, source.stat().st_size + required)
        staged = directory / "workbench_demo.dem"
        shutil.copyfile(source, staged)
    except FileNotFoundError:
        raise RecordError("DEMO_PARSE_FAILED", "找不到任务里的本地 demo 文件。") from None
    except OSError:
        raise RecordError(
            "OUTPUT_WRITE_FAILED", "无法暂存 demo，请检查读取权限和可用空间。"
        ) from None
    return staged


def _demo_size(source: Path) -> int:
    try:
        return source.stat().st_size
    except FileNotFoundError:
        raise RecordError("DEMO_PARSE_FAILED", "找不到任务里的本地 demo 文件。") from None
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法读取 demo 的文件大小。") from None


def _capture_sequence(
    files: Sequence[Path],
    expected_frames: int,
    expected_size: tuple[int, int],
    *,
    pad_tail: bool = False,
) -> RawCapture:
    audio = [file for file in files if file.suffix.lower() == ".wav"]
    frames = [file for file in files if file.suffix.lower() == ".tga"]
    if not frames or len(audio) != 1:
        raise CaptureIncomplete("录制未生成完整的 TGA 图像序列和 WAV 游戏音频。")
    ordered = []
    groups = set()
    for frame in frames:
        match = re.fullmatch(r"(.*?)([0-9]+)(\.tga)", frame.name, re.IGNORECASE)
        with frame.open("rb") as stream:
            header = stream.read(19)
        if match is None or len(header) != 19:
            raise CaptureIncomplete("录制图像命名无效或文件不完整。")
        # TGA 的宽度和高度各占两个字节，从偏移 12 开始按小端存放。
        width, height = struct.unpack_from("<HH", header, 12)
        if (width, height) != expected_size:
            expected_width, expected_height = expected_size
            raise CaptureIncomplete(
                f"游戏实际录制分辨率为 {width}×{height}，"
                f"预期为 {expected_width}×{expected_height}。"
            )
        prefix, number, suffix = match.groups()
        groups.add((frame.parent, prefix, len(number), suffix))
        ordered.append(int(number))
    ordered.sort()
    if (
        len(groups) != 1
        or ordered[-1] - ordered[0] + 1 != len(ordered)
        or len(set(ordered)) != len(ordered)
    ):
        raise CaptureIncomplete("录制图像编号不连续。")

    # demo 为 64 tick/s，录制为 60 fps，容许起止帧量化造成的少量偏差。
    if abs(len(ordered) - expected_frames) > 3:
        raise CaptureIncomplete("实际录制帧数与所选片段时长不符。")
    frame_count = min(len(ordered), expected_frames)
    try:
        with wave.open(str(audio[0]), "rb") as wav:
            sample_frames = wav.getnframes()
            if sample_frames == 0:
                raise CaptureIncomplete("录制生成的 WAV 游戏音频没有采样。")
            wav.setpos(sample_frames - 1)
            if not wav.readframes(1):
                raise CaptureIncomplete("录制生成的 WAV 游戏音频不完整。")
            audio_duration = sample_frames / wav.getframerate()
    except (EOFError, OSError, wave.Error, ZeroDivisionError):
        raise CaptureIncomplete("录制生成的 WAV 游戏音频无法读取。") from None
    if audio_duration <= 0 or abs(audio_duration - frame_count / 60) > 0.25:
        raise CaptureIncomplete("录制音频与图像时长不符。")
    parent, prefix, digits, suffix = groups.pop()
    pattern = (
        Path(str(parent).replace("%", "%%")) / f"{prefix.replace('%', '%%')}%0{digits}d{suffix}"
    )
    # 受害者窗口保留指定时长，帧率量化导致的少量缺口延续最后一帧。
    padding = expected_frames - frame_count if pad_tail else 0
    return RawCapture(pattern, ordered[0], frame_count + padding, audio[0], expected_size, padding)


def ffmpeg_argv(executable: Path, raw: RawCapture, output: Path) -> list[str]:
    width, height = OUTPUT_SIZE
    video_filter = "setsar=1"
    if raw.source_size != OUTPUT_SIZE:
        video_filter = f"scale={width}:{height}:flags=lanczos,{video_filter}"
    if raw.tail_padding_frames:
        video_filter += f",tpad=stop_mode=clone:stop={raw.tail_padding_frames}"
    return [
        str(executable),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-framerate",
        "60",
        "-start_number",
        str(raw.first_frame),
        "-i",
        str(raw.pattern),
        "-i",
        str(raw.audio),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        video_filter,
        "-r",
        "60",
        "-fps_mode",
        "cfr",
        "-t",
        f"{raw.frame_count / 60:.8f}",
        "-af",
        "apad",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output),
    ]


def _wait_for_game(
    job: WindowsJob,
    tools: CaptureTools,
    profile: Path,
    timeout: float,
    aspect: CaptureAspect,
    storage: Sequence[Path] = (),
) -> None:
    try:
        argv = hlae_argv(tools.hlae, tools.cs2, profile, aspect=aspect)
        launch = job.start(argv, cwd=tools.hlae.parent)
        deadline = time.monotonic() + timeout
        # HLAE 的无界面启动器先退出，Job 仍跟踪它启动的 CS2。
        while job.active_processes():
            if launch.poll() not in (None, 0):
                raise RecordError("RECORD_FAILED", "HLAE 无法启动离线 CS2 回放。")
            if time.monotonic() >= deadline:
                raise RecordError("RECORD_FAILED", "等待 CS2 离线录制结束超时。")
            for path in storage:
                _check_space(path, 16 * 1024**2)
            time.sleep(0.1)
        if launch.poll() != 0:
            raise RecordError("RECORD_FAILED", "HLAE 无法启动离线 CS2 回放。")
    except OSError:
        raise RecordError("RECORD_FAILED", "无法启动或监视受托管的 CS2 进程。") from None


def _wait_for_encoder(process: WindowsProcess, timeout: float) -> int:
    # 在 Python 中短间隔等待，使 Ctrl+C 在编码期间也能及时进入清理流程。
    deadline = time.monotonic() + timeout
    while (code := process.poll()) is None:
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired("CS2 编码子进程", timeout)
        time.sleep(0.1)
    return code


def _encoding_exit_code(job: WindowsJob, argv: Sequence[str], cwd: Path, timeout: float) -> int:
    # stderr 留在本次工作目录，用于区分空间/I/O 错误和可回退的编码错误。
    try:
        with tempfile.TemporaryFile(dir=cwd) as diagnostics:
            process = job.start(argv, cwd=cwd, stderr=diagnostics)
            code = _wait_for_encoder(process, timeout)
            if code != 0:
                diagnostics.seek(max(0, diagnostics.seek(0, os.SEEK_END) - 65536))
                message = diagnostics.read().lower()
                if any(
                    text in message
                    for text in (
                        b"no space left",
                        b"not enough space",
                        b"disk quota exceeded",
                        b"input/output error",
                        b"i/o error",
                        b"permission denied",
                        b"read-only file system",
                        b"error opening output",
                        b"error writing",
                        b"failed to write",
                    )
                ):
                    raise RecordError(
                        "OUTPUT_WRITE_FAILED", "编码文件写入失败，请检查磁盘空间和权限。"
                    )
                _check_space(cwd, 16 * 1024**2)
            return code
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法启动编码或写入临时文件。") from None


def _run_encoder(
    job: WindowsJob, tools: CaptureTools, raw: RawCapture, output: Path, report: Path
) -> float:
    try:
        code = _encoding_exit_code(
            job, ffmpeg_argv(tools.ffmpeg, raw, output), output.parent, max(90, raw.frame_count)
        )
        if code != 0 or not output.is_file():
            raise RecordError("FFMPEG_FAILED", "FFmpeg 未能生成 MP4 文件。")
        probe = _encoding_exit_code(
            job,
            [
                str(tools.ffprobe),
                "-v",
                "error",
                "-of",
                "json",
                "-show_entries",
                "stream=codec_type,codec_name,width,height,avg_frame_rate,sample_aspect_ratio"
                ":format=duration",
                "-o",
                str(report),
                str(output),
            ],
            output.parent,
            30,
        )
        if probe != 0:
            raise RecordError("FFMPEG_FAILED", "无法读取成品的画面和音轨信息。")
        metadata = json.loads(report.read_text(encoding="utf-8"))
        streams = metadata["streams"]
        duration = float(metadata["format"]["duration"])
        good_video = any(
            stream["codec_type"] == "video"
            and stream["codec_name"] == "h264"
            and (stream.get("width"), stream.get("height")) == OUTPUT_SIZE
            and stream.get("avg_frame_rate") == "60/1"
            and stream.get("sample_aspect_ratio") == "1:1"
            for stream in streams
        )
        good_audio = any(
            stream["codec_type"] == "audio" and stream["codec_name"] == "aac" for stream in streams
        )
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法读取录制编码结果。") from None
    except (KeyError, TypeError, ValueError, subprocess.SubprocessError):
        raise RecordError("FFMPEG_FAILED", "编码或验证 MP4 文件失败。") from None
    if (
        not good_video
        or not good_audio
        or not math.isfinite(duration)
        or (abs(duration - raw.frame_count / 60) > 0.1)
    ):
        raise RecordError("FFMPEG_FAILED", "成品的分辨率、帧率、音轨或时长与任务不符。")
    return duration


def _record_attempt(
    task: RecordTask,
    tools: CaptureTools,
    staged_demo: Path,
    directory: Path,
    temporary_mp4: Path,
    state_dir: Path,
    worker_command: Sequence[str],
    method: RecordingMethod,
    notify: Callable[[str, int, str], None],
    *,
    observer_crosshair: bool,
) -> tuple[float, float, int]:
    profile = directory / "profile"
    capture = directory / "capture"
    capture.mkdir(parents=True)
    job_name = new_recording_job_name()
    prefix = native_prefix_for_job(job_name)
    csgo = tools.gameinfo.parent
    native_roots = (csgo, csgo.parent / "bin" / "win64", profile)
    segment = task.segment
    write_capture_config(
        profile,
        staged_demo,
        capture,
        task.player_id,
        segment.start_tick,
        segment.end_tick,
        method=method,
        native_prefix=prefix,
        observer_crosshair=observer_crosshair,
        death_tick=task.death_tick,
        xray=task.xray,
    )
    with (
        WindowsJob(job_name) as job,
        GameInfoProtection(
            tools.gameinfo,
            state_dir,
            worker_command,
            job_name=job_name,
            native_profile=profile if method == "startmovie" else None,
        ),
    ):
        try:
            _ensure_cs2_closed()
            notify("record", 0, "已校验 gameinfo.gi 备份，正在启动离线回放。")
            started = time.monotonic()
            storage = (capture, csgo) if method == "startmovie" else (capture,)
            _wait_for_game(
                job, tools, profile, max(180, segment.duration_s * 60), task.aspect, storage
            )
            elapsed = time.monotonic() - started
            files = (
                list(capture.rglob("*.tga")) + list(capture.glob("take*/audio.wav"))
                if method == "hlae"
                else sorted(native_outputs(native_roots, prefix))
            )
            raw = _capture_sequence(
                files,
                math.ceil(segment.duration_s * 60),
                task.capture_size,
                pad_tail=task.death_tick is not None,
            )
            notify("record", 1, "逐帧录制完成，已退出 CS2。")
            notify("compose", 0, "正在编码并验证 1080p 60 fps MP4。")
            duration = _run_encoder(job, tools, raw, temporary_mp4, directory / "probe.json")
            if task.keep_raw and method == "startmovie":
                for item in files:
                    shutil.copyfile(item, capture / item.name)
        finally:
            # 先结束子进程，再退出保护上下文。看护进程在引擎崩溃时按同样顺序恢复。
            job.terminate()
    return duration, elapsed, raw.tail_padding_frames


def record_segment(
    task: RecordTask,
    worker_command: Sequence[str],
    notify: Callable[[str, int, str], None],
    warning: Callable[[str], None],
    *,
    observer_crosshair: bool | None = None,
) -> RecordedClip:
    if os.name != "nt":
        raise RecordError("RECORD_FAILED", "P2 录制原型需要 Windows。")
    tools = _capture_tools(task)
    state_dir = _recovery_dir()
    segment_seconds = task.segment.duration_s
    raw_needed = raw_bytes(segment_seconds, task.capture_size)
    fallback_reason = None
    retained = None
    try:
        task.work_dir.mkdir(parents=True, exist_ok=True)
        task.output_dir.mkdir(parents=True, exist_ok=True)
        scratch = _staging_root(task.work_dir)
        check_recording_space(
            task.output_dir,
            scratch,
            (segment_seconds,),
            capture_size=task.capture_size,
            demo_bytes=_demo_size(task.demo_path),
            keep_raw=task.keep_raw,
            compilation=False,
            native_dir=tools.gameinfo.parent if task.method == "startmovie" else None,
        )
        with tempfile.TemporaryDirectory(prefix="workbench-cs2-", dir=scratch) as private:
            private_path = Path(private)
            notify("prepare", 0, "正在把 demo 放入独立录制目录。")
            staged = _stage_demo(
                task.demo_path, private_path, 0 if task.method == "startmovie" else raw_needed
            )
            if observer_crosshair is None:
                notify("prepare", 0, "正在读取准星…")
                observer_crosshair = has_recorded_crosshair(
                    staged, task.player_id, task.segment.start_tick
                )
            if not observer_crosshair:
                warning("未能从 demo 读取目标玩家的准星，使用 CS2 默认准星。")
            notify("prepare", 1, "录制输入已就绪。")
            methods = ("hlae", "startmovie") if task.method == "auto" else (task.method,)
            token = uuid4().hex
            target = task.output_dir / f"cs2-clip-{token[:12]}.mp4"
            for method in methods:
                if method == "startmovie":
                    _check_space(tools.gameinfo.parent, raw_needed)
                try:
                    with tempfile.TemporaryDirectory(prefix=f"{method}-", dir=private_path) as raw:
                        attempt = Path(raw)
                        temporary_mp4 = attempt / "clip.mp4"
                        duration, elapsed, padding = _record_attempt(
                            task,
                            tools,
                            staged,
                            attempt,
                            temporary_mp4,
                            state_dir,
                            worker_command,
                            method,
                            notify,
                            observer_crosshair=observer_crosshair,
                        )
                        size = temporary_mp4.stat().st_size
                        if size <= 0:
                            raise RecordError("FFMPEG_FAILED", "MP4 文件为空。")
                        _publish_video(temporary_mp4, target)
                        if task.keep_raw:
                            retained = scratch / f"raw-{token}"
                            (attempt / "capture").replace(retained)
                except CaptureIncomplete as error:
                    if task.method != "auto" or method != "hlae":
                        raise
                    fallback_reason = str(error)
                    warning(f"HLAE 逐帧录制未通过校验。{error}改用 CS2 原生 startmovie。")
                    continue
                break
    except OSError:
        raise RecordError(
            "OUTPUT_WRITE_FAILED", "录制工作目录、游戏临时文件或成品无法读写。"
        ) from None
    notify("compose", 1, "MP4 已验证，gameinfo.gi 校验通过。")
    return RecordedClip(target, method, duration, elapsed, size, fallback_reason, padding, retained)
