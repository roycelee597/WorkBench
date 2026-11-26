import errno
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from cs2_engine import batch_capture
from cs2_engine.compilation import VideoInfo
from cs2_engine.record_task import RecordError, RecordTask, Segment
from cs2_engine.recording import CaptureIncomplete, CaptureTools


@pytest.fixture
def session(tmp_path, monkeypatch):
    tools = CaptureTools(
        tmp_path / "cs2.exe",
        tmp_path / "gameinfo.gi",
        tmp_path / "HLAE.exe",
        tmp_path / "ffmpeg.exe",
        tmp_path / "ffprobe.exe",
    )
    task = RecordTask(
        tmp_path / "synthetic.dem",
        tmp_path,
        tmp_path,
        tools.cs2,
        tools.hlae,
        tools.ffmpeg,
        "00000000000000001",
        Segment(1, 128, 192, 1),
        "auto",
    )
    state = SimpleNamespace(
        task=task,
        outputs=[tmp_path / f"output-{index}.mp4" for index in range(4)],
        lifecycle=[],
        warnings=[],
        completed={},
        captures=[],
        processed=[],
        failure=None,
    )

    class Job:
        def __init__(self, name=None):
            self.name = name

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            state.lifecycle.append("game_job_closed" if self.name else "encoder_job_closed")

        def start(self, args, *, cwd):
            assert args[0] == str(tools.hlae) and cwd == tools.hlae.parent
            state.lifecycle.append("game_started")
            return self

        def active_processes(self):
            # 游戏只在最后一段完成确认后退出。
            final_ack = state.captures[0].parent / "markers/3.continue"
            return int(not final_ack.exists())

        def terminate(self):
            state.lifecycle.append("game_terminated")

    class Protection:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            assert state.lifecycle[-1] == "game_terminated"
            state.lifecycle.append("gameinfo_checked")

    write_original_config = batch_capture._write_batch_config

    def write_config(profile, demo, tasks, captures, crosshairs):
        state.captures = captures
        write_original_config(profile, demo, tasks, captures, crosshairs)

    def wait_for_clip(_job, _launch, markers, capture, index, _output, _timeout):
        state.processed.append(index)
        for past in range(index):
            assert not state.captures[past].exists()
            assert (markers / f"{past}.continue").is_file()
        # 无法锁定第三段视角时，游戏只留下 skip 标记。
        if index == 2:
            return False
        assert capture == state.captures[index]
        capture.mkdir()
        (capture / f"frame-{index}.tga").touch()
        return True

    def capture_sequence(files, _frames, _size, *, pad_tail):
        index = int(files[0].stem.split("-")[1])
        assert pad_tail is False
        if index == 1 and state.failure == "raw":
            raise CaptureIncomplete("合成原始文件缺失。")
        return SimpleNamespace(index=index, tail_padding_frames=int(index == 0))

    def run_encoder(job, _tools, raw, output, _report):
        assert job.name is None and "game_terminated" not in state.lifecycle
        output.write_bytes(str(raw.index).encode("ascii"))
        if raw.index == 1 and state.failure == "encoder":
            raise RecordError("OUTPUT_WRITE_FAILED", "合成写盘失败。")
        return 1.0

    def read_video_info(_job, _ffprobe, output, _report):
        if output.read_bytes() == b"1" and not state.failure:
            raise RecordError("FFMPEG_FAILED", "合成视频校验失败。")
        return VideoInfo(1, 1, 1, 1920, 1080, 60, "1:1", "h264", "aac", 60)

    def publish_video(source, target):
        if target == state.outputs[1] and state.failure == "publish":
            raise OSError(errno.ENOSPC, "synthetic disk full")
        source.replace(target)

    monkeypatch.setattr(batch_capture, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(batch_capture, "WindowsJob", Job)
    monkeypatch.setattr(batch_capture, "GameInfoProtection", Protection)
    monkeypatch.setattr(batch_capture, "_capture_tools", lambda _: tools)
    monkeypatch.setattr(batch_capture, "_staging_root", lambda _: tmp_path)
    monkeypatch.setattr(batch_capture, "_stage_demo", lambda *_: task.demo_path)
    monkeypatch.setattr(batch_capture, "_ensure_cs2_closed", lambda: None)
    monkeypatch.setattr(batch_capture, "_recovery_dir", lambda: tmp_path)
    monkeypatch.setattr(batch_capture, "_write_batch_config", write_config)
    monkeypatch.setattr(batch_capture, "_wait_for_clip", wait_for_clip)
    monkeypatch.setattr(batch_capture, "_capture_sequence", capture_sequence)
    monkeypatch.setattr(batch_capture, "_run_encoder", run_encoder)
    monkeypatch.setattr(batch_capture, "_read_video_info", read_video_info)
    monkeypatch.setattr(batch_capture, "_publish_video", publish_video)
    monkeypatch.setattr(batch_capture, "require_free_space", lambda *_: None)
    return state


def _record(session):
    return batch_capture.record_multiple(
        [(session.task, output) for output in session.outputs],
        ["synthetic"],
        lambda *_: None,
        session.warnings.append,
        crosshairs=[True] * len(session.outputs),
        completed=session.completed,
    )


@pytest.mark.parametrize("keep_raw", [False, True])
def test_batch_encodes_and_cleans_each_clip_before_releasing_game(session, keep_raw):
    session.task = replace(session.task, keep_raw=keep_raw)
    completed = _record(session)

    assert completed is session.completed
    assert list(completed) == [0, 3]
    assert completed[0].tail_padding_frames == 1
    assert completed[0].probe["frame_count"] == 60
    assert session.processed == list(range(4))
    assert [path.exists() for path in session.outputs] == [True, False, False, True]
    assert session.lifecycle.count("game_started") == 1
    assert session.lifecycle.count("encoder_job_closed") == 3
    assert session.lifecycle[-3:] == ["game_terminated", "gameinfo_checked", "game_job_closed"]
    assert not session.captures[0].parent.exists()
    assert any("第 2 段" in warning for warning in session.warnings)
    assert any("补齐了 1 帧" in warning for warning in session.warnings)
    kept = list(session.task.work_dir.glob("batch-raw-*"))
    if keep_raw:
        assert len(kept) == 1
        assert sorted(item.name for item in kept[0].iterdir()) == ["output-0", "output-3"]
        assert completed[0].raw_output == kept[0] / "output-0"
        assert (completed[0].raw_output / "frame-0.tga").is_file()
    else:
        assert kept == []
        assert completed[0].raw_output is None


@pytest.mark.parametrize("failure", ["encoder", "publish", "raw"])
def test_batch_storage_error_aborts_and_only_keeps_finished_clips(session, failure, monkeypatch):
    session.task = replace(session.task, keep_raw=True)
    session.failure = failure
    if failure == "raw":

        def write_denied(folder):
            assert folder == session.captures[1]
            raise RecordError("OUTPUT_WRITE_FAILED", "合成原始文件目录不可写。")

        monkeypatch.setattr(batch_capture, "_verify_writable", write_denied)

    with pytest.raises(RecordError) as error:
        _record(session)

    assert error.value.code == "OUTPUT_WRITE_FAILED"
    assert session.processed == [0, 1]
    assert list(session.completed) == [0]
    assert session.completed[0].raw_output.is_dir()
    assert [path.exists() for path in session.outputs] == [True, False, False, False]
    assert not session.captures[0].parent.exists()
    assert session.lifecycle[-3:] == ["game_terminated", "gameinfo_checked", "game_job_closed"]


def test_disk_reserve_checked_before_waiting_for_raw_marker(tmp_path, monkeypatch):
    class Game:
        def poll(self):
            pytest.fail("Disk shortage must stop before waiting for the game")

    def no_space(*_args):
        raise RecordError("OUTPUT_WRITE_FAILED", "合成磁盘空间不足。")

    monkeypatch.setattr(batch_capture, "require_free_space", no_space)

    with pytest.raises(RecordError) as error:
        batch_capture._wait_for_clip(Game(), Game(), tmp_path, tmp_path / "capture", 0, tmp_path, 1)

    assert error.value.code == "OUTPUT_WRITE_FAILED"


@pytest.mark.parametrize("failed_directory", ["markers", "screen", None])
def test_abnormal_exit_checks_marker_and_raw_directories_before_fallback(
    tmp_path, monkeypatch, failed_directory
):
    markers = tmp_path / "markers"
    markers.mkdir()
    capture = tmp_path / "capture"
    screen = capture / "take0000" / "screen"
    screen.mkdir(parents=True)
    checked = []

    def verify(directory):
        checked.append(directory.name)
        if directory.name == failed_directory:
            raise RecordError("OUTPUT_WRITE_FAILED", "合成工作目录写入失败。")

    game = SimpleNamespace(poll=lambda: 0, active_processes=lambda: 0)
    monkeypatch.setattr(batch_capture, "require_free_space", lambda *_: None)
    monkeypatch.setattr(batch_capture, "_verify_writable", verify)

    with pytest.raises(RecordError) as error:
        batch_capture._wait_for_clip(game, game, markers, capture, 0, tmp_path, 1)

    assert error.value.code == ("OUTPUT_WRITE_FAILED" if failed_directory else "RECORD_FAILED")
    assert checked == (
        ["markers"]
        if failed_directory == "markers"
        else [
            "markers",
            "capture",
            "take0000",
            "screen",
        ]
    )


def test_hlae_marker_write_error_aborts_even_when_storage_probe_would_pass(tmp_path):
    (tmp_path / "marker-write-failed.xml").write_text("<campath />")
    markers = tmp_path / "markers"
    markers.mkdir()

    with pytest.raises(RecordError, match="HLAE 无法写入") as error:
        batch_capture._wait_for_clip(None, None, markers, tmp_path / "capture", 0, tmp_path, 1)

    assert error.value.code == "OUTPUT_WRITE_FAILED"


def test_raw_capture_directory_must_stay_inside_session(tmp_path, monkeypatch):
    capture = tmp_path / "session" / "take-0000"
    original_resolve = Path.resolve

    def redirected(path, **kwargs):
        if path == capture:
            return tmp_path / "other-run"
        return original_resolve(path, **kwargs)

    monkeypatch.setattr(Path, "resolve", redirected)

    with pytest.raises(RecordError, match="已被重定向") as error:
        batch_capture._verify_raw_writable(capture)

    assert error.value.code == "OUTPUT_WRITE_FAILED"
