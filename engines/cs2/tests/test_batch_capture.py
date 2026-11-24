from types import SimpleNamespace

from cs2_engine import batch_capture
from cs2_engine.record_task import RecordError, RecordTask, Segment
from cs2_engine.recording import CaptureTools


def test_batch_encodes_valid_clips_after_game_timeout_and_skips_individual_failures(
    tmp_path, monkeypatch
):
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
        "76561198000000001",
        Segment(1, 128, 192, 1),
        "auto",
    )
    outputs = [tmp_path / f"output-{index}.mp4" for index in range(4)]
    lifecycle = []
    warnings = []

    class Job:
        def __init__(self, name=None):
            self.name = name
            self.terminated = False

        def __enter__(self):
            if self.name is None:
                assert lifecycle[:3] == ["game_terminated", "gameinfo_checked", "game_job_closed"]
            return self

        def __exit__(self, *_args):
            lifecycle.append("game_job_closed" if self.name else "encoder_job_closed")

        def terminate(self):
            self.terminated = True
            lifecycle.append("game_terminated")

    class Protection:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            pass

        def __exit__(self, *_args):
            assert lifecycle == ["game_terminated"]
            lifecycle.append("gameinfo_checked")

    def wait_for_game(*_args):
        raise RecordError("RECORD_FAILED", "合成超时。")

    def write_config(_profile, _demo, _tasks, captures, _crosshairs):
        for index, capture in enumerate(captures):
            capture.mkdir()
            (capture / f"frame-{index}.tga").touch()

    def capture_sequence(files, _frames, _size, *, pad_tail):
        index = int(files[0].stem.split("-")[1])
        assert pad_tail is False
        if index == 1:
            raise OSError("synthetic read failure")
        return index

    def run_encoder(job, _tools, index, output, _report):
        assert not job.terminated and job.name is None
        output.write_bytes(str(index).encode("ascii"))
        return 1.0

    def read_video_info(_job, _ffprobe, output, _report):
        if output.read_bytes() == b"2":
            raise RecordError("FFMPEG_FAILED", "合成视频校验失败。")

    monkeypatch.setattr(batch_capture, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(batch_capture, "WindowsJob", Job)
    monkeypatch.setattr(batch_capture, "GameInfoProtection", Protection)
    monkeypatch.setattr(batch_capture, "_capture_tools", lambda _: tools)
    monkeypatch.setattr(batch_capture, "_staging_root", lambda _: tmp_path)
    monkeypatch.setattr(batch_capture, "_stage_demo", lambda *_: task.demo_path)
    monkeypatch.setattr(batch_capture, "_ensure_cs2_closed", lambda: None)
    monkeypatch.setattr(batch_capture, "_recovery_dir", lambda: tmp_path)
    monkeypatch.setattr(batch_capture, "_write_batch_config", write_config)
    monkeypatch.setattr(batch_capture, "_wait_for_game", wait_for_game)
    monkeypatch.setattr(batch_capture, "_capture_sequence", capture_sequence)
    monkeypatch.setattr(batch_capture, "_run_encoder", run_encoder)
    monkeypatch.setattr(batch_capture, "_read_video_info", read_video_info)

    completed = batch_capture.record_multiple(
        [(task, output) for output in outputs],
        ["synthetic"],
        lambda *_: None,
        warnings.append,
        crosshairs=[True] * len(outputs),
    )

    assert list(completed) == [0, 3]
    assert [path.exists() for path in outputs] == [True, False, False, True]
    assert lifecycle.count("encoder_job_closed") == 3
    assert any("合成超时" in warning for warning in warnings)
    assert any("第 2 段" in warning for warning in warnings)
    assert any("第 3 段" in warning for warning in warnings)
