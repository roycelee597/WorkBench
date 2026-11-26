import errno
import json
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from cs2_engine import __main__ as cli
from cs2_engine import batch, disk_space
from cs2_engine.batch_plan import BatchClip
from cs2_engine.models import Demo, Player
from cs2_engine.record_task import RecordError, RecordTask, Segment
from cs2_engine.recording import CaptureTools, RecordedClip

_PLAYER = "00000000000000001"
_VICTIM = "00000000000000002"


@dataclass(frozen=True)
class _Probe:
    video_duration_s: float = 1.0
    audio_duration_s: float = 1.0


def _task_and_tools(tmp_path):
    demo = tmp_path / "session.dem"
    demo.write_bytes(b"PBDEMS2\x00synthetic")
    tools = CaptureTools(
        tmp_path / "cs2.exe",
        tmp_path / "gameinfo.gi",
        tmp_path / "HLAE.exe",
        tmp_path / "ffmpeg.exe",
        tmp_path / "ffprobe.exe",
    )
    return RecordTask(
        demo,
        tmp_path / "work",
        tmp_path / "output",
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
    progress = []
    queries = []

    def recorded_crosshairs(demo, targets):
        assert demo == task.demo_path
        assert progress[-1] == "正在读取准星…"
        queries.append(targets)
        return {(_PLAYER, 100), (_VICTIM, 140)}

    def record_multiple(items, *_args, crosshairs, completed):
        assert crosshairs == [True, False, True]
        _, target = items[0]
        target.write_bytes(b"synthetic")
        completed[0] = RecordedClip(target, "hlae", 1, 2, 9, probe=asdict(_Probe()))
        return completed

    def record_segment(item, *_args, observer_crosshair):
        retries.append((item.death_tick, observer_crosshair))
        if item.death_tick == 168:
            raise RecordError("RECORD_FAILED", "片段未生成。")
        assert item.output_dir == item.work_dir and item.work_dir.parent == task.work_dir
        target = item.output_dir / "temporary.mp4"
        target.write_bytes(b"synthetic")
        return RecordedClip(target, "hlae", 1, 3, 9, tail_padding_frames=2)

    def compile_videos(_ffmpeg, _ffprobe, inputs, output, *, work_dir):
        assert work_dir == task.work_dir
        compositions[output.name] = [path.name for path in inputs]
        output.write_bytes(b"synthetic")
        return _Probe()

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "recorded_crosshairs", recorded_crosshairs)
    monkeypatch.setattr(batch, "record_multiple", record_multiple)
    monkeypatch.setattr(batch, "record_segment", record_segment)
    monkeypatch.setattr(batch, "probe_video", lambda *_args, **_kwargs: _Probe())
    monkeypatch.setattr(batch, "compile_videos", compile_videos)

    summary = batch.record_batch(
        task, clips, ["synthetic"], lambda *args: progress.append(args[-1]), warnings.append
    )
    saved = Path(summary["output_dir"]) / "batch-results.json"

    assert json.loads(saved.read_text(encoding="utf-8")) == summary
    assert queries == [[(_PLAYER, 100), (_VICTIM, 120), (_VICTIM, 140)]]
    assert progress.count("正在读取准星…") == 1
    assert retries == [(168, False), (188, True)]
    assert compositions == {
        "highlights.mp4": [clips[0].filename],
        "victims.mp4": [clips[2].filename],
    }
    assert summary["single_session_segments"] == 1
    assert summary["single_session_elapsed_s"] == 2
    assert summary["individual_attempts"] == 2
    assert [(row["id"], row["kill_index"]) for row in summary["segments"]] == [(1, None), (1, 2)]
    assert [row["tail_padding_frames"] for row in summary["segments"]] == [0, 2]
    assert len(summary["failures"]) == 1
    assert summary["failures"][0]["kill_index"] == 1
    assert summary["failures"][0]["message"] == "片段未生成。"
    assert _VICTIM not in repr(summary)
    assert any("片段未生成" in line for line in warnings)
    assert any("补齐 2 帧" in line for line in warnings)


def test_batch_leaves_no_unverified_mp4_or_victim_without_a_living_frame(tmp_path, monkeypatch):
    task, tools = _task_and_tools(tmp_path)
    clips = (
        BatchClip("player", task.segment, 4, "multikill", _PLAYER),
        BatchClip("victim", Segment(1, 120, 184, 1), 4, "multikill", _VICTIM, 1, 120),
    )

    def record_segment(item, *_args, observer_crosshair):
        assert observer_crosshair is False
        target = item.output_dir / "unverified.mp4"
        target.write_bytes(b"invalid")
        return RecordedClip(target, "hlae", 1, 1, 7)

    def probe_video(*_args, **_kwargs):
        raise RecordError("FFMPEG_FAILED", "音视频时长不符。")

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "recorded_crosshairs", lambda *_args: set())
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
    completed = BatchClip("player", task.segment, 1, "multikill", _PLAYER)
    unfinished = BatchClip("victim", Segment(1, 120, 184, 1), 1, "multikill", _VICTIM, 1, 168)
    published = []
    warnings = []

    def cancel(items, *_args, completed, **_kwargs):
        _, output = items[0]
        output.write_bytes(b"verified MP4")
        completed[0] = RecordedClip(output, "hlae", 1, 2, 12, probe=asdict(_Probe()))
        published.append(output)
        raise KeyboardInterrupt

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "recorded_crosshairs", lambda *_args: set())
    monkeypatch.setattr(batch, "record_multiple", cancel)
    monkeypatch.setattr(
        batch, "record_segment", lambda *_args, **_kwargs: pytest.fail("entered retry after cancel")
    )
    with pytest.raises(KeyboardInterrupt):
        batch.record_batch(
            task, (completed, unfinished), ["synthetic"], lambda *_: None, warnings.append
        )

    assert published[0].read_bytes() == b"verified MP4"
    (summary_path,) = tmp_path.rglob("batch-results.json")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["cancelled"] is True
    assert [item["output"] for item in summary["segments"]] == [str(published[0])]
    assert summary["segments"][0]["probe"] == asdict(_Probe())
    assert [(item["perspective"], item["kill_index"]) for item in summary["uncompleted"]] == [
        ("victim", 1)
    ]
    assert summary["single_session_segments"] == 1
    assert summary["individual_attempts"] == 0
    assert str(summary_path) in warnings[-1]
    assert not list(tmp_path.rglob(".batch-summary-*"))


def test_cli_reports_disk_shortage_and_exits_before_capture(tmp_path, monkeypatch, capsys):
    task, tools = _task_and_tools(tmp_path)
    clips = (
        BatchClip("player", task.segment, 1, "multikill", _PLAYER),
        BatchClip("victim", Segment(1, 120, 184, 1), 1, "multikill", _VICTIM, 1, 168),
    )
    monkeypatch.setattr(
        cli, "_parse_demo", lambda _path: Demo(64, (Player(_PLAYER, "Synthetic"),), ())
    )
    monkeypatch.setattr(cli, "score_demo", lambda *_args, **_kwargs: [{"kind": "synthetic"}])
    monkeypatch.setattr(cli, "plan_batch", lambda *_args, **_kwargs: clips)
    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(disk_space, "disk_usage", lambda _path: SimpleNamespace(free=100_000_000))
    for callback in ("recorded_crosshairs", "record_multiple", "record_segment"):
        monkeypatch.setattr(
            batch,
            callback,
            lambda *_args, **_kwargs: pytest.fail("Batch ran past disk-space preflight"),
        )

    exit_code = cli.main(
        [
            "record-batch",
            "--demo",
            str(task.demo_path),
            "--player",
            "Synthetic",
            "--all",
            "--out",
            str(task.output_dir),
            "--work-dir",
            str(task.work_dir),
            "--cs2-path",
            str(tools.cs2),
            "--hlae-path",
            str(tools.hlae),
            "--ffmpeg-path",
            str(tools.ffmpeg),
        ]
    )

    assert exit_code == 1
    final = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert final["type"] == "error" and final["code"] == "OUTPUT_WRITE_FAILED"
    assert (task.work_dir.drive or "/") in final["message"]
    assert "需要约 " in final["message"] and "可用 0.10 GB，还差 " in final["message"]
    assert not task.output_dir.exists()
    assert not task.work_dir.exists()
    assert not list(tmp_path.rglob("*.mp4"))
    assert not list(tmp_path.rglob(".batch-summary-*"))


@pytest.mark.parametrize("failure_stage", ["bulk", "fallback", "output-summary"])
def test_batch_storage_failure_preserves_clips_and_lists_disjoint_outcomes(
    tmp_path, monkeypatch, failure_stage
):
    task, tools = _task_and_tools(tmp_path)
    clips = (
        BatchClip("player", task.segment, 1, "multikill", _PLAYER),
        *(
            BatchClip(
                "victim", Segment(1, start, start + 64, 1), 1, "multikill", who, kill, start + 40
            )
            for kill, (start, who) in enumerate(
                ((120, _VICTIM), (140, _VICTIM), (160, _VICTIM), (180, None)), 1
            )
        ),
    )

    def record_multiple(items, *_args, completed, **_kwargs):
        _, output = items[0]
        output.write_bytes(b"verified MP4")
        completed[0] = RecordedClip(output, "hlae", 1, 2, 12, probe=asdict(_Probe()))
        if failure_stage != "fallback":
            raise RecordError("OUTPUT_WRITE_FAILED", "合成磁盘空间不足。")
        return completed

    def record_segment(item, *_args, **_kwargs):
        assert failure_stage == "fallback"
        if item.segment.start_tick == 120:
            raise RecordError("RECORD_FAILED", "合成回放错误。")
        assert item.segment.start_tick == 140
        (item.output_dir / "incomplete.mp4").write_bytes(b"partial")
        raise OSError(errno.ENOSPC, "synthetic disk full")

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "recorded_crosshairs", lambda *_args: set())
    monkeypatch.setattr(batch, "record_multiple", record_multiple)
    monkeypatch.setattr(batch, "record_segment", record_segment)
    monkeypatch.setattr(
        batch, "compile_videos", lambda *_args, **_kwargs: pytest.fail("Composed after disk error")
    )
    if failure_stage == "output-summary":
        save_summary = batch._save_summary

        def save_summary_on_work_disk(reserved, target, summary):
            if target.is_relative_to(task.output_dir):
                raise OSError(errno.ENOSPC, "synthetic output disk full")
            save_summary(reserved, target, summary)

        monkeypatch.setattr(batch, "_save_summary", save_summary_on_work_disk)

    summary = batch.record_batch(task, clips, ["synthetic"], lambda *_: None, lambda _: None)

    saved = Path(summary.pop("summary"))
    assert json.loads(saved.read_text(encoding="utf-8")) == summary
    assert summary["error"]["code"] == "OUTPUT_WRITE_FAILED"
    assert summary["cancelled"] is False
    (completed,) = summary["segments"]
    assert Path(completed["output"]).read_bytes() == b"verified MP4"
    assert summary["single_session_segments"] == 1
    assert [row["kill_index"] for row in summary["failures"]] == (
        [4, 1, 2] if failure_stage == "fallback" else [4]
    )
    assert [row["kill_index"] for row in summary["uncompleted"]] == (
        [3] if failure_stage == "fallback" else [1, 2, 3]
    )
    if failure_stage == "output-summary":
        assert saved.is_relative_to(task.work_dir)
        assert list(task.work_dir.iterdir()) == [saved.parent]
    else:
        assert saved.is_relative_to(task.output_dir)
        assert list(task.work_dir.iterdir()) == []
    assert not list(tmp_path.rglob(".batch-summary-*"))


def test_batch_keeps_published_compilation_if_second_compilation_runs_out_of_space(
    tmp_path, monkeypatch
):
    task, tools = _task_and_tools(tmp_path)
    clips = (
        BatchClip("player", task.segment, 1, "multikill", _PLAYER),
        BatchClip("victim", Segment(1, 120, 184, 1), 1, "multikill", _VICTIM, 1, 168),
    )

    def record_multiple(items, *_args, completed, **_kwargs):
        for index, (_, output) in enumerate(items):
            output.write_bytes(b"verified MP4")
            completed[index] = RecordedClip(output, "hlae", 1, 2, 12, probe=asdict(_Probe()))
        return completed

    def compile_videos(_ffmpeg, _ffprobe, _inputs, output, *, work_dir):
        assert work_dir == task.work_dir
        if output.name == "victims.mp4":
            raise RecordError("OUTPUT_WRITE_FAILED", "合成磁盘空间不足。")
        output.write_bytes(b"verified compilation")
        return _Probe()

    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "recorded_crosshairs", lambda *_args: set())
    monkeypatch.setattr(batch, "record_multiple", record_multiple)
    monkeypatch.setattr(batch, "compile_videos", compile_videos)
    summary = batch.record_batch(task, clips, ["synthetic"], lambda *_: None, lambda _: None)

    assert summary["error"]["code"] == "OUTPUT_WRITE_FAILED"
    assert len(summary["segments"]) == 2
    assert summary["uncompleted"] == []
    assert list(summary["compilations"]) == ["player"]
    assert Path(summary["compilations"]["player"]["output"]).read_bytes() == b"verified compilation"
    assert summary["failures"][0]["compilation"] == "victims.mp4"
    assert not list(tmp_path.rglob("victims.mp4"))


def test_failed_raw_retention_keeps_already_published_mp4_in_summary(tmp_path, monkeypatch):
    task, tools = _task_and_tools(tmp_path)
    task = replace(task, keep_raw=True)
    clips = (
        BatchClip("player", task.segment, 1, "multikill", _PLAYER),
        BatchClip("victim", Segment(1, 120, 184, 1), 1, "multikill", _VICTIM, 1, 168),
    )

    def record_segment(item, *_args, **_kwargs):
        assert item.death_tick is None and item.keep_raw
        output = item.output_dir / "recording.mp4"
        output.write_bytes(b"verified MP4")
        raw = item.work_dir / "retained-raw"
        raw.mkdir()
        (raw / "frame.tga").write_bytes(b"synthetic raw")
        return RecordedClip(output, "hlae", 1, 2, 12, raw_output=raw)

    replace_path = Path.replace

    def fail_to_keep_raw(source, destination):
        if source.name == "retained-raw":
            raise OSError(errno.EACCES, "synthetic raw retention failure")
        return replace_path(source, destination)

    monkeypatch.setattr(Path, "replace", fail_to_keep_raw)
    monkeypatch.setattr(batch, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(batch, "recorded_crosshairs", lambda *_args: set())
    monkeypatch.setattr(batch, "record_multiple", lambda *_args, completed, **_kwargs: completed)
    monkeypatch.setattr(batch, "record_segment", record_segment)
    monkeypatch.setattr(batch, "probe_video", lambda *_args, **_kwargs: _Probe())

    summary = batch.record_batch(task, clips, ["synthetic"], lambda *_: None, lambda _: None)

    assert summary["error"]["code"] == "OUTPUT_WRITE_FAILED"
    (completed,) = summary["segments"]
    assert completed["raw_output"] is None
    assert Path(completed["output"]).read_bytes() == b"verified MP4"
    assert summary["failures"] == []
    assert [item["kill_index"] for item in summary["uncompleted"]] == [1]
    assert list(task.work_dir.iterdir()) == []


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
