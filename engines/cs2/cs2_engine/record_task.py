import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

type CaptureMethod = Literal["auto", "hlae", "startmovie"]


class RecordError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class Segment:
    index: int
    start_tick: int
    end_tick: int
    duration_s: float


@dataclass(frozen=True, slots=True)
class RecordTask:
    demo_path: Path
    work_dir: Path
    output_dir: Path
    cs2_path: Path
    hlae_path: Path
    ffmpeg_path: Path
    player_id: str
    segment: Segment
    method: CaptureMethod


def validate_record_path(path: Path) -> Path:
    resolved = path.resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        production_dir = (Path(local_app_data) / "com.royce.workbench").resolve()
        if resolved.is_relative_to(production_dir):
            raise RecordError("PERMISSION_DENIED", "录制任务不能使用正式版 WorkBench 数据目录。")
    return resolved


def _task_path(task: dict, key: str, base: Path) -> Path:
    value = task.get(key)
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise RecordError("INVALID_TASK", f"{key} 必须是有效的文件或目录路径。")
    return validate_record_path(base / value)


def _segment(path: Path, index: object, player_id: str) -> Segment:
    if type(index) is not int or index < 1:
        raise RecordError("INVALID_TASK", "segment_index 必须是从 1 开始的片段序号。")
    try:
        preview = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise RecordError("INVALID_TASK", "无法读取 P1 输出的 highlights.json。") from None
    if not isinstance(preview, dict) or not isinstance(preview.get("highlights"), list):
        raise RecordError("INVALID_TASK", "highlights.json 缺少 P1 片段列表。")
    clips = preview["highlights"]
    if index > len(clips) or not isinstance(clips[index - 1], dict):
        raise RecordError("INVALID_TASK", "highlights.json 里没有所选片段。")
    players = preview.get("players")
    if not isinstance(players, list) or not any(
        isinstance(player, dict) and player.get("steamid64") == player_id for player in players
    ):
        raise RecordError("PLAYER_NOT_FOUND", "P1 预览里没有所选玩家。")
    start = clips[index - 1].get("start_tick")
    end = clips[index - 1].get("end_tick")
    duration = clips[index - 1].get("duration_s")
    if (
        type(start) is not int
        or type(end) is not int
        or not 0 <= start < end <= 2**31 - 1
        or type(duration) not in (int, float)
        or duration != (end - start) / 64
    ):
        raise RecordError("INVALID_TASK", "所选片段的起止 tick 或时长无效。")
    return Segment(index, start, end, float(duration))


def read_record_task(task: dict, base: Path) -> RecordTask:
    player = task.get("player")
    steamid64 = player.get("steamid64") if isinstance(player, dict) else None
    if (
        not isinstance(steamid64, str)
        or len(steamid64) != 17
        or not steamid64.isascii()
        or not steamid64.isdecimal()
    ):
        raise RecordError("INVALID_TASK", "player.steamid64 必须是由 17 位数字组成的字符串。")

    if (
        task.get("resolution", "1080p") != "1080p"
        or task.get("aspect", "16:9") != "16:9"
        or task.get("fps", 60) != 60
        or task.get("victim_pov", False) is not False
        or task.get("resume", False) is not False
    ):
        raise RecordError("INVALID_TASK", "P2 支持单段 16:9 1080p、60 fps 的目标玩家视角。")
    method = task.get("recording_method", "auto")
    if method not in ("auto", "hlae", "startmovie"):
        raise RecordError("INVALID_TASK", "recording_method 必须是 auto、hlae 或 startmovie。")

    demo = _task_path(task, "demo_path", base)
    if demo.suffix.lower() != ".dem":
        raise RecordError("INVALID_TASK", "demo_path 必须指向解压后的 .dem 文件。")
    return RecordTask(
        demo_path=demo,
        work_dir=_task_path(task, "work_dir", base),
        output_dir=_task_path(task, "output_dir", base),
        cs2_path=_task_path(task, "cs2_path", base),
        hlae_path=_task_path(task, "hlae_path", base),
        ffmpeg_path=_task_path(task, "ffmpeg_path", base),
        player_id=steamid64,
        segment=_segment(
            _task_path(task, "highlights_path", base), task.get("segment_index"), steamid64
        ),
        method=method,
    )
