import json
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from math import isfinite
from pathlib import Path
from tempfile import TemporaryDirectory

from .record_task import OUTPUT_SIZE, RecordError
from .recording import _encoding_exit_code, _publish_video
from .windows_job import WindowsJob

_FPS = 60
_AUDIO_RATE = 48000
_SAMPLES_PER_FRAME = _AUDIO_RATE // _FPS
_FADE_FRAMES = 9
_PROBE_ENTRIES = (
    "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,"
    "sample_aspect_ratio,start_time,duration,nb_frames,sample_rate:format=duration"
)


@dataclass(frozen=True, slots=True)
class VideoInfo:
    duration_s: float
    video_duration_s: float
    audio_duration_s: float
    width: int
    height: int
    fps: int
    sample_aspect_ratio: str
    video_codec: str
    audio_codec: str
    frame_count: int


def _video_info(metadata: dict) -> VideoInfo:
    error = RecordError("FFMPEG_FAILED", "MP4 的分辨率、帧率、编码或音视频时长不符合录制规格。")
    try:
        (video,) = [stream for stream in metadata["streams"] if stream["codec_type"] == "video"]
        (audio,) = [stream for stream in metadata["streams"] if stream["codec_type"] == "audio"]
        width, height = video["width"], video["height"]
        sar = video["sample_aspect_ratio"]
        video_codec, audio_codec = video["codec_name"], audio["codec_name"]
        fps = Fraction(video["avg_frame_rate"])
        real_fps = Fraction(video["r_frame_rate"])
        frame_count = int(video["nb_frames"])
        duration = float(metadata["format"]["duration"])
        video_duration = float(video["duration"])
        audio_duration = float(audio["duration"])
        video_start = float(video["start_time"])
        audio_start = float(audio["start_time"])
        sample_rate = int(audio["sample_rate"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError):
        raise error from None
    if sample_rate <= 0 or not all(
        isfinite(value)
        for value in (duration, video_duration, audio_duration, video_start, audio_start)
    ):
        raise error
    # 允许 AAC 每包 1024 个样本和一帧视频造成的封装量化。
    tolerance = 1024 / sample_rate + 1 / _FPS
    if (
        (width, height) != OUTPUT_SIZE
        or fps != _FPS
        or real_fps != _FPS
        or sar != "1:1"
        or (video_codec, audio_codec) != ("h264", "aac")
        or frame_count < 1
        or min(duration, video_duration, audio_duration) <= 0
        or abs(video_duration - frame_count / _FPS) > 0.001
        or abs(video_start) > tolerance
        or abs(audio_start) > tolerance
        or abs(video_start - audio_start) > tolerance
        or abs(video_duration - audio_duration) > tolerance
        or abs(duration - max(video_duration, audio_duration)) > tolerance
    ):
        raise error
    return VideoInfo(
        duration,
        video_duration,
        audio_duration,
        width,
        height,
        _FPS,
        sar,
        video_codec,
        audio_codec,
        frame_count,
    )


def _probe_argv(ffprobe: Path, source: Path, report: Path) -> list[str]:
    return [
        str(ffprobe),
        "-v",
        "error",
        "-of",
        "json",
        "-show_entries",
        _PROBE_ENTRIES,
        "-o",
        str(report),
        str(source),
    ]


def _run(job: WindowsJob, argv: Sequence[str], cwd: Path, timeout: float, failure: str) -> None:
    try:
        code = _encoding_exit_code(job, argv, cwd, timeout)
    except subprocess.TimeoutExpired:
        raise RecordError("FFMPEG_FAILED", failure) from None
    if code != 0:
        raise RecordError("FFMPEG_FAILED", failure)


def _read_video_info(job: WindowsJob, ffprobe: Path, path: Path, report: Path) -> VideoInfo:
    failure = "ffprobe 无法读取 MP4 的视频和音频信息。"
    try:
        _run(job, _probe_argv(ffprobe, path, report), report.parent, 30, failure)
        metadata = json.loads(report.read_text(encoding="utf-8"))
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法读取 ffprobe 的临时结果。") from None
    except ValueError:
        raise RecordError("FFMPEG_FAILED", failure) from None
    return _video_info(metadata)


def probe_video(ffprobe: Path, path: Path, *, work_dir: Path | None = None) -> VideoInfo:
    """检查单段或合集，返回 ffprobe 测得的格式、帧数和时长。"""
    try:
        with (
            TemporaryDirectory(prefix="workbench-cs2-probe-", dir=work_dir) as workspace,
            WindowsJob() as job,
        ):
            report = Path(workspace) / "probe.json"
            return _read_video_info(job, ffprobe.resolve(), path.resolve(), report)
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法写入 ffprobe 的临时文件。") from None
    except ValueError:
        raise RecordError("FFMPEG_FAILED", "无法启动 ffprobe 或写入验证结果。") from None


def compilation_clip_argv(
    ffmpeg: Path,
    source: Path,
    output: Path,
    frame_count: int,
    *,
    fade_in: bool,
    fade_out: bool,
) -> list[str]:
    """给相邻片段应用合计约 0.3 秒的黑场过渡并对齐音视频。"""
    sample_count = frame_count * _SAMPLES_PER_FRAME
    video = f"trim=end_frame={frame_count},setpts=PTS-STARTPTS,setsar=1"
    audio = (
        f"aresample={_AUDIO_RATE},aformat=channel_layouts=stereo,"
        f"apad=whole_len={sample_count},atrim=end_sample={sample_count},asetpts=PTS-STARTPTS"
    )
    fade_frames = min(_FADE_FRAMES, frame_count // max(1, fade_in + fade_out))
    if fade_in and fade_frames:
        video += f",fade=t=in:s=0:n={fade_frames}"
        audio += f",afade=t=in:ss=0:ns={fade_frames * _SAMPLES_PER_FRAME}"
    if fade_out and fade_frames:
        start = frame_count - fade_frames
        video += f",fade=t=out:s={start}:n={fade_frames}"
        audio += f",afade=t=out:ss={start * _SAMPLES_PER_FRAME}"
        audio += f":ns={fade_frames * _SAMPLES_PER_FRAME}"
    return [
        str(ffmpeg),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-n",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        video,
        "-af",
        audio,
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-c:a",
        "pcm_s16le",
        str(output),
    ]


def compilation_argv(ffmpeg: Path, manifest: Path, output: Path) -> list[str]:
    # FFmpeg 从清单所在目录读取本地中间文件，所有文件名都由引擎生成。
    return [
        str(ffmpeg),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-n",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        manifest.name,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output),
    ]


def compile_videos(
    ffmpeg: Path,
    ffprobe: Path,
    inputs: Sequence[Path],
    output: Path,
    *,
    work_dir: Path | None = None,
) -> VideoInfo:
    """按输入顺序拼接单段，验证成功后原子发布合集。"""
    if not inputs:
        raise RecordError("FFMPEG_FAILED", "没有可拼接的单段视频。")
    try:
        ffmpeg, ffprobe = ffmpeg.resolve(), ffprobe.resolve()
        output = output.absolute()
        sources = [path.resolve() for path in inputs]
        if output.resolve() in sources:
            raise RecordError("FFMPEG_FAILED", "合集路径必须和单段视频不同。")
        with TemporaryDirectory(
            prefix=".wb-cs2-compile-", dir=work_dir or output.parent
        ) as workspace:
            directory = Path(workspace)
            report = directory / "probe.json"
            manifest = directory / "inputs.ffconcat"
            temporary = directory / "compilation.mp4"
            lines = ["ffconcat version 1.0"]
            total_frames = 0
            with WindowsJob() as job:
                for index, path in enumerate(sources):
                    info = _read_video_info(job, ffprobe, path, report)
                    intermediate = directory / f"clip-{index:06d}.nut"
                    argv = compilation_clip_argv(
                        ffmpeg,
                        path,
                        intermediate,
                        info.frame_count,
                        fade_in=index > 0,
                        fade_out=index < len(sources) - 1,
                    )
                    _run(job, argv, directory, max(90, info.frame_count), "单段淡入淡出处理失败。")
                    lines.extend(
                        [f"file {intermediate.name}", f"duration {info.frame_count / _FPS:.8f}"]
                    )
                    total_frames += info.frame_count
                # 中间段使用 PCM，合并后只编码一次 AAC，避免叠加编码预延迟。
                manifest.write_text("\n".join(lines) + "\n", encoding="ascii")
                _run(
                    job,
                    compilation_argv(ffmpeg, manifest, temporary),
                    directory,
                    max(90, total_frames),
                    "FFmpeg 无法拼接合集。",
                )
                info = _read_video_info(job, ffprobe, temporary, report)
                if info.frame_count != total_frames:
                    raise RecordError("FFMPEG_FAILED", "合集视频的帧数与单段合计不符。")
            _publish_video(temporary, output)
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法写入合集临时文件或发布成品。") from None
    except ValueError:
        raise RecordError("FFMPEG_FAILED", "无法启动编码进程或写入合集成品。") from None
    return info
