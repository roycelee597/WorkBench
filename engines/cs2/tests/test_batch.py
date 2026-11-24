from dataclasses import dataclass

import pytest

from cs2_engine import __main__ as cli
from cs2_engine import batch
from cs2_engine.batch_plan import BatchClip
from cs2_engine.models import Demo, Player
from cs2_engine.record_task import RecordError, RecordTask, Segment
from cs2_engine.recording import CaptureTools, RecordedClip

_PLAYER = "76561198000000001"
_VICTIM = "76561198000000002"


@dataclass(frozen=True)
class _Probe:
    video_duration_s: float = 1.0
    audio_duration_s: float = 1.0


def _task_and_tools(tmp_path):
    demo = tmp_path / "session.dem"
    tools = CaptureTools(
        tmp_path / "cs2.exe",
        tmp_path / "gameinfo.gi",
        tmp_path / "HLAE.exe",
        tmp_path / "ffmpeg.exe",
        tmp_path / "ffprobe.exe",
    )
    return RecordTask(
        demo,
        tmp_path,
        tmp_path,
        tools.cs2,
        tools.hlae,
        tools.ffmpeg,
        _PLAYER,
        Segment(1, 100, 164, 1),
        "auto",
    ), tools


def test_batch_retries_missing_segments_and_skips_a_failed_victim(tmp_path, monkeypatch):
    task, tools = _task_and_tools(tmp_path)
    clips = (
        BatchClip("player", task.segment, 4, "multikill", _PLAYER),
        BatchClip("victim", Segment(1, 120, 184, 1), 4, "multikill", _VICTIM, 1, 168),
        BatchClip("victim", Segment(1, 140, 204, 1), 4, "multikill", _VICTIM, 2, 188),
    )
    retries = []
    compositions = {}
    warnings = []

    def record_multiple(items, *_args):
        _, target = items[0]
        target.write_bytes(b"synthetic")
        return {0: RecordedClip(target, "hlae", 1, 2, 9)}

    def record_segment(item, *_args):
        retries.append(item.death_tick)
        if item.death_tick == 168:
            raise RecordError("RECORD_FAILED", "片段未生成。")
        target = item.output_dir / "temporary.mp4"
        target.write_bytes(b"synthetic")
        return RecordedClip(target, "hlae", 1, 3, 9)

    def compile_videos(_ffmpeg, _ffprobe, inputs, output):
        compositions[output.name] = [path.name for path in inputs]
        output.write_bytes(b"synthetic")
        return _Probe()

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "record_multiple", record_multiple)
    monkeypatch.setattr(batch, "record_segment", record_segment)
    monkeypatch.setattr(batch, "probe_video", lambda *_args: _Probe())
    monkeypatch.setattr(batch, "compile_videos", compile_videos)

    summary = batch.record_batch(task, clips, ["synthetic"], lambda *_: None, warnings.append)

    assert retries == [168, 188]
    assert compositions == {
        "highlights.mp4": [clips[0].filename],
        "victims.mp4": [clips[2].filename],
    }
    assert summary["single_session_segments"] == 1
    assert summary["single_session_elapsed_s"] == 2
    assert summary["individual_attempts"] == 2
    assert [(row["id"], row["kill_index"]) for row in summary["segments"]] == [(1, None), (1, 2)]
    assert len(summary["failures"]) == 1
    assert summary["failures"][0]["kill_index"] == 1
    assert summary["failures"][0]["message"] == "片段未生成。"
    assert _VICTIM not in repr(summary)
    assert any("片段未生成" in line for line in warnings)


def test_batch_leaves_no_unverified_mp4_or_victim_without_a_living_frame(tmp_path, monkeypatch):
    task, tools = _task_and_tools(tmp_path)
    clips = (
        BatchClip("player", task.segment, 4, "multikill", _PLAYER),
        BatchClip("victim", Segment(1, 120, 184, 1), 4, "multikill", _VICTIM, 1, 120),
    )

    def record_segment(item, *_args):
        target = item.output_dir / "unverified.mp4"
        target.write_bytes(b"invalid")
        return RecordedClip(target, "hlae", 1, 1, 7)

    def probe_video(*_args):
        raise RecordError("FFMPEG_FAILED", "音视频时长不符。")

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "record_segment", record_segment)
    monkeypatch.setattr(batch, "probe_video", probe_video)
    summary = batch.record_batch(task, clips, ["synthetic"], lambda *_: None, lambda _: None)

    assert summary["segments"] == []
    assert summary["individual_attempts"] == 1
    assert [error["code"] for error in summary["failures"]] == [
        "RECORD_FAILED",
        "FFMPEG_FAILED",
        "COMPILE_FAILED",
        "COMPILE_FAILED",
    ]
    assert next(tmp_path.rglob("*.mp4"), None) is None


def test_batch_cancellation_propagates_and_does_not_start_fallback(tmp_path, monkeypatch):
    task, tools = _task_and_tools(tmp_path)
    clip = BatchClip("player", task.segment, 1, "multikill", _PLAYER)

    def cancel(*_args):
        raise KeyboardInterrupt

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "record_multiple", cancel)
    monkeypatch.setattr(
        batch, "record_segment", lambda *_: pytest.fail("entered retry after cancel")
    )
    with pytest.raises(KeyboardInterrupt):
        batch.record_batch(task, (clip, clip), ["synthetic"], lambda *_: None, lambda _: None)


def test_list_command_prints_number_round_type_tags_and_duration(tmp_path, monkeypatch, capsys):
    demo = tmp_path / "session.dem"
    monkeypatch.setattr(
        cli, "_parse_demo", lambda _path: Demo(64, (Player(_PLAYER, "Synthetic"),), ())
    )
    monkeypatch.setattr(
        cli,
        "score_demo",
        lambda *_args, **_kwargs: [
            {"round": 4, "types": ["multikill"], "tags": ["3k"], "duration_s": 1.5}
        ],
    )

    assert cli.main(["list-highlights", "--demo", str(demo), "--player", "Synthetic"]) == 0
    output = capsys.readouterr().out
    assert "1\t4\tmultikill / 3k\t1.50" in output
    assert _PLAYER not in output
