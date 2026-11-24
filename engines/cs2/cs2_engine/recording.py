import csv
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

from .gameinfo import (
    GameInfoProtection,
    native_prefix_for_job,
    new_recording_job_name,
    recover_gameinfo,
)
from .native_capture import native_outputs
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


@dataclass(frozen=True, slots=True)
class RecordedClip:
    output: Path
    method: RecordingMethod
    duration_s: float
    capture_elapsed_s: float
    size_bytes: int
    fallback_reason: str | None = None


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
    for path in (Path(tempfile.gettempdir()), work_dir):
        path = validate_record_path(path)
        value = path.as_posix()
        if value.isascii() and not any(ord(char) < 32 or char in '";' for char in value):
            return path
    raise RecordError("INVALID_TASK", "系统临时目录含非 ASCII 字符，请提供英文 work_dir。")


def _check_space(path: Path, required: int) -> None:
    if shutil.disk_usage(path).free < required:
        raise RecordError("OUTPUT_WRITE_FAILED", "录制磁盘空间不足，无法保存逐帧文件。")


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


def _capture_sequence(
    files: Sequence[Path], expected_frames: int, expected_size: tuple[int, int]
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
    return RawCapture(pattern, ordered[0], frame_count, audio[0], expected_size)


def ffmpeg_argv(executable: Path, raw: RawCapture, output: Path) -> list[str]:
    width, height = OUTPUT_SIZE
    video_filter = "setsar=1"
    if raw.source_size != OUTPUT_SIZE:
        video_filter = f"scale={width}:{height}:flags=lanczos,{video_filter}"
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
    job: WindowsJob, tools: CaptureTools, profile: Path, timeout: float, aspect: CaptureAspect
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


def _run_encoder(
    job: WindowsJob, tools: CaptureTools, raw: RawCapture, output: Path, report: Path
) -> float:
    try:
        encode = job.start(ffmpeg_argv(tools.ffmpeg, raw, output), cwd=output.parent)
        if _wait_for_encoder(encode, max(90, raw.frame_count)) != 0 or not output.is_file():
            raise RecordError("FFMPEG_FAILED", "FFmpeg 未能生成 MP4 文件。")
        probe = job.start(
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
            cwd=output.parent,
        )
        if _wait_for_encoder(probe, 30) != 0:
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
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
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
) -> tuple[float, float]:
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
            _wait_for_game(job, tools, profile, max(180, segment.duration_s * 60), task.aspect)
            elapsed = time.monotonic() - started
            files = (
                list(capture.rglob("*.tga")) + list(capture.glob("take*/audio.wav"))
                if method == "hlae"
                else sorted(native_outputs(native_roots, prefix))
            )
            raw = _capture_sequence(files, math.ceil(segment.duration_s * 60), task.capture_size)
            notify("record", 1, "逐帧录制完成，已退出 CS2。")
            notify("compose", 0, "正在编码并验证 1080p 60 fps MP4。")
            duration = _run_encoder(job, tools, raw, temporary_mp4, directory / "probe.json")
        finally:
            # 先结束子进程，再退出保护上下文。看护进程在引擎崩溃时按同样顺序恢复。
            job.terminate()
    return duration, elapsed


def record_segment(
    task: RecordTask,
    worker_command: Sequence[str],
    notify: Callable[[str, int, str], None],
    warning: Callable[[str], None],
) -> RecordedClip:
    if os.name != "nt":
        raise RecordError("RECORD_FAILED", "P2 录制原型需要 Windows。")
    tools = _capture_tools(task)
    state_dir = _recovery_dir()
    expected = math.ceil(task.segment.duration_s * 60)
    width, height = task.capture_size
    raw_bytes = expected * width * height * 4 + 64 * 1024**2
    fallback_reason = None
    try:
        task.work_dir.mkdir(parents=True, exist_ok=True)
        task.output_dir.mkdir(parents=True, exist_ok=True)
        scratch = _staging_root(task.work_dir)
        with (
            tempfile.TemporaryDirectory(prefix="workbench-cs2-", dir=scratch) as private,
            tempfile.TemporaryDirectory(prefix=".cs2-output-", dir=task.output_dir) as encoding,
        ):
            private_path = Path(private)
            temporary_mp4 = Path(encoding) / "clip.mp4"
            notify("prepare", 0, "正在把 demo 放入独立录制目录。")
            staged = _stage_demo(task.demo_path, private_path, raw_bytes)
            notify("prepare", 1, "录制输入已就绪。")
            methods = ("hlae", "startmovie") if task.method == "auto" else (task.method,)
            for method in methods:
                if method == "startmovie":
                    _check_space(tools.gameinfo.parent, raw_bytes)
                try:
                    duration, elapsed = _record_attempt(
                        task,
                        tools,
                        staged,
                        private_path / method,
                        temporary_mp4,
                        state_dir,
                        worker_command,
                        method,
                        notify,
                    )
                except CaptureIncomplete as error:
                    if task.method != "auto" or method != "hlae":
                        raise
                    fallback_reason = str(error)
                    warning(f"HLAE 逐帧录制未通过校验。{error}改用 CS2 原生 startmovie。")
                    continue
                break
            target = task.output_dir / f"cs2-clip-{uuid4().hex[:12]}.mp4"
            size = temporary_mp4.stat().st_size
            if size <= 0:
                raise RecordError("FFMPEG_FAILED", "MP4 文件为空。")
            temporary_mp4.replace(target)
    except OSError:
        raise RecordError(
            "OUTPUT_WRITE_FAILED", "录制工作目录、游戏临时文件或成品无法读写。"
        ) from None
    notify("compose", 1, "MP4 已验证，gameinfo.gi 校验通过。")
    return RecordedClip(target, method, duration, elapsed, size, fallback_reason)
