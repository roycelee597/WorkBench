import json
import os
import wave
from pathlib import Path

import pytest

from cs2_engine import __main__ as cli
from cs2_engine import recording
from cs2_engine.native_capture import native_outputs
from cs2_engine.record_task import RecordError, Segment, read_record_task
from cs2_engine.recording_commands import hlae_argv, write_capture_config

PLAYER = "00000000000000001"


def _task(directory: Path) -> dict:
    (directory / "highlights.json").write_text(
        json.dumps(
            {
                "players": [{"steamid64": PLAYER}],
                "highlights": [{"start_tick": 1000, "end_tick": 1064, "duration_s": 1}],
            }
        ),
        encoding="utf-8",
    )
    return {
        "schema_version": 1,
        "mode": "record",
        "demo_path": "测试 对局.dem",
        "highlights_path": "highlights.json",
        "segment_index": 1,
        "player": {"steamid64": PLAYER},
        "work_dir": "预览 任务",
        "output_dir": "成品 输出",
        "cs2_path": "假 游戏",
        "hlae_path": "假工具/HLAE.exe",
        "ffmpeg_path": "假工具/ffmpeg.exe",
    }


def test_record_task_paths_and_selected_segment_are_resolved(tmp_path):
    task = read_record_task(_task(tmp_path), tmp_path)

    assert task.demo_path == tmp_path / "测试 对局.dem"
    assert task.output_dir == tmp_path / "成品 输出"
    assert task.segment == Segment(1, 1000, 1064, 1)


@pytest.mark.parametrize(
    "changes, code",
    [
        ({"segment_index": 2}, "INVALID_TASK"),
        ({"segment_index": True}, "INVALID_TASK"),
        ({"player": {"steamid64": "00000000000000002"}}, "PLAYER_NOT_FOUND"),
        ({"resolution": "1440p"}, "INVALID_TASK"),
        ({"demo_path": "match.zip"}, "INVALID_TASK"),
    ],
)
def test_record_task_reports_invalid_inputs(tmp_path, changes, code):
    with pytest.raises(RecordError) as failure:
        read_record_task({**_task(tmp_path), **changes}, tmp_path)

    assert failure.value.code == code


def test_record_task_rejects_production_data_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local-app-data"))
    task = {**_task(tmp_path), "output_dir": "local-app-data/com.royce.workbench/videos"}
    with pytest.raises(RecordError) as failure:
        read_record_task(task, tmp_path)

    assert failure.value.code == "PERMISSION_DENIED"


def test_staging_copies_chinese_and_spaced_demo_to_stable_name(tmp_path):
    original = tmp_path / "测试 对局.dem"
    original.write_bytes(b"PBDEMS2\x00synthetic")
    staging = tmp_path / "staging"
    staging.mkdir()

    copied = recording._stage_demo(original, staging, 0)

    assert copied == staging / "workbench_demo.dem"
    assert copied.read_bytes() == original.read_bytes()


def test_hlae_arguments_isolate_game_and_preserve_spaces():
    hlae = Path("Tools with spaces") / "HLAE.exe"
    cs2 = Path("Game with spaces") / "cs2.exe"
    profile = Path("Capture with spaces") / "profile"
    argv = hlae_argv(hlae, cs2, profile)
    cmdline = argv[argv.index("-cmdLine") + 1]

    assert argv[argv.index("-programPath") + 1] == str(cs2)
    assert argv[argv.index("-hookDllPath") + 1] == str(hlae.parent / "x64/AfxHookSource2.dll")
    assert argv[argv.index("-addEnv") + 1] == f"USRLOCALCSGO={profile}"
    assert "-noConfig" in argv and "-noGui" in argv
    assert "-insecure" in cmdline and "-afxDisableSteamStorage" in cmdline
    assert "+exec workbench_p2" in cmdline and "-w 1920 -h 1080" in cmdline


@pytest.mark.parametrize(
    "method, start, stop",
    [
        ("hlae", "mirv_streams record start", "mirv_streams record end"),
        ("startmovie", "startmovie wbp2_test", "endmovie; host_framerate 0"),
    ],
)
def test_generated_config_uses_exact_steamid_and_tick_bounds(tmp_path, method, start, stop):
    profile = tmp_path / "profile"
    write_capture_config(
        profile,
        Path("demo with spaces.dem"),
        Path("raw frames"),
        PLAYER,
        1000,
        1064,
        method=method,
        native_prefix="wbp2_test",
    )
    cfg = (profile / "cfg/workbench_p2.cfg").read_text(encoding="ascii")
    script = (profile / "cfg/workbench_p2.js").read_text(encoding="ascii")
    settings = json.loads(script.splitlines()[0].removeprefix("const options = ").rstrip(";"))

    assert 'playdemo "demo with spaces.dem"' in cfg
    assert 'mirv_script_load "mirv_script_spec_lock.js"' in cfg
    assert settings["steamid"] == PLAYER
    assert (settings["seek"], settings["start"], settings["end"]) == (872, 1000, 1064)
    assert settings["begin"] == start and settings["stop"] == stop
    assert "getSteamId() === wanted" in script and "spec_mode 1" in script
    if method == "hlae":
        assert "afxClassic" in settings["setup"] and "startMovieWav 1" in settings["setup"]
    else:
        assert settings["setup"] == "host_framerate 60"


def test_unsafe_console_path_is_rejected_without_launch(tmp_path):
    with pytest.raises(ValueError, match="ASCII"):
        write_capture_config(
            tmp_path / "profile",
            Path("bad;quit.dem"),
            Path("raw"),
            PLAYER,
            100,
            200,
            method="hlae",
            native_prefix="wbp2_test",
        )


def _write_tga_wav(directory: Path, frames=60) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(frames):
        path = directory / f"{index:05d}.tga"
        path.write_bytes(bytes(24))
        paths.append(path)
    wav = directory / "audio.wav"
    with wave.open(str(wav), "wb") as audio:
        audio.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x01\x00" * 48000)
    return [*paths, wav]


def test_raw_frames_and_audio_build_explicit_1080p_60fps_ffmpeg_command(tmp_path):
    raw = recording._capture_sequence(_write_tga_wav(tmp_path / "影片 素材"), 60)
    args = recording.ffmpeg_argv(Path("ffmpeg.exe"), raw, tmp_path / "clip.mp4")

    assert args[args.index("-framerate") + 1] == "60"
    assert args[args.index("-start_number") + 1] == "0"
    assert "scale=1920:1080:flags=lanczos,setsar=1" in args
    assert "1:a:0" in args and "aac" in args and "libx264" in args
    assert raw.pattern.name == "%05d.tga" and raw.audio.name == "audio.wav"


def test_incomplete_frames_or_missing_audio_cannot_be_reported_as_a_clip(tmp_path):
    files = _write_tga_wav(tmp_path)
    with pytest.raises(recording.CaptureIncomplete):
        recording._capture_sequence(files[:-1], 60)
    with pytest.raises(recording.CaptureIncomplete, match="编号不连续"):
        recording._capture_sequence(files[:5] + files[6:], 60)
    with pytest.raises(recording.CaptureIncomplete, match="帧数"):
        recording._capture_sequence(files[:30] + files[-1:], 60)


def test_native_files_are_scoped_to_the_unique_recording_prefix(tmp_path):
    prefix = "wbp2_" + "0" * 32
    folder = tmp_path / "movie"
    folder.mkdir()
    this_frame = folder / f"{prefix}00000.tga"
    this_audio = folder / f"{prefix}.wav"
    unrelated = folder / "other-session.wav"
    for file in (this_frame, this_audio, unrelated):
        file.touch()

    assert native_outputs([tmp_path], prefix) == {this_frame, this_audio}


def test_cli_record_success_and_cancellation_are_structured(tmp_path, monkeypatch, capsys):
    payload = _task(tmp_path)
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(payload), encoding="utf-8")

    def complete(task, _command, progress, _warning):
        task.work_dir.mkdir(exist_ok=True)
        progress("record", 1, "录制完成。")
        return recording.RecordedClip(task.output_dir / "clip.mp4", "hlae", 1, 3, 10)

    monkeypatch.setattr(cli, "record_segment", complete)
    assert cli.main(["run", "--task", str(task_file)]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[0]["segment_id"] == 1
    assert events[-1]["type"] == "done" and events[-1]["gameinfo_restored"] is True

    def cancel(*args):
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "record_segment", cancel)
    assert cli.main(["run", "--task", str(task_file)]) == 1
    assert json.loads(capsys.readouterr().out)["code"] == "CANCELLED"


def test_capture_cancel_terminates_job_before_restoring_config(tmp_path, monkeypatch):
    calls = []

    class Job:
        def __init__(self, _name):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            calls.append("close")

        def terminate(self):
            calls.append("terminate")

    class Protection:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            calls.append("backup")

        def __exit__(self, *_args):
            calls.append("restore")

    def cancel(*args):
        calls.append("launch")
        raise KeyboardInterrupt

    monkeypatch.setattr(recording, "WindowsJob", Job)
    monkeypatch.setattr(recording, "GameInfoProtection", Protection)
    monkeypatch.setattr(recording, "write_capture_config", lambda *args, **kwargs: None)
    monkeypatch.setattr(recording, "_ensure_cs2_closed", lambda: None)
    monkeypatch.setattr(recording, "_wait_for_game", cancel)
    task = read_record_task(_task(tmp_path), tmp_path)
    tools = recording.CaptureTools(
        tmp_path / "cs2.exe",
        tmp_path / "gameinfo.gi",
        tmp_path / "HLAE.exe",
        tmp_path / "ffmpeg.exe",
        tmp_path / "ffprobe.exe",
    )
    with pytest.raises(KeyboardInterrupt):
        recording._record_attempt(
            task,
            tools,
            task.demo_path,
            tmp_path / "staging",
            tmp_path / "clip.mp4",
            tmp_path / "state",
            ["synthetic"],
            "hlae",
            lambda *args: None,
        )

    assert calls == ["backup", "launch", "terminate", "restore", "close"]


@pytest.mark.skipif(os.name != "nt", reason="单段录制是 Windows 功能")
def test_auto_uses_native_capture_after_incomplete_hlae_and_publishes_one_file(
    tmp_path, monkeypatch
):
    task = read_record_task(_task(tmp_path), tmp_path)
    task.demo_path.write_bytes(b"PBDEMS2\x00synthetic")
    tools = recording.CaptureTools(
        tmp_path / "cs2.exe",
        tmp_path / "gameinfo.gi",
        tmp_path / "HLAE.exe",
        tmp_path / "ffmpeg.exe",
        tmp_path / "ffprobe.exe",
    )
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "app-data"))
    monkeypatch.setattr(recording, "_capture_tools", lambda _task: tools)
    monkeypatch.setattr(recording, "_staging_root", lambda _work_dir: tmp_path)
    monkeypatch.setattr(recording, "_check_space", lambda *_args: None)
    attempts = []
    warnings = []

    def attempt(_task, _tools, _demo, _directory, mp4, _state, _worker, method, _notify):
        attempts.append(method)
        if method == "hlae":
            raise recording.CaptureIncomplete("图像未生成。")
        mp4.write_bytes(b"synthetic mp4")
        return 1, 2

    monkeypatch.setattr(recording, "_record_attempt", attempt)
    clip = recording.record_segment(task, ["synthetic"], lambda *args: None, warnings.append)

    assert attempts == ["hlae", "startmovie"]
    assert len(warnings) == 1 and "图像未生成" in warnings[0]
    assert clip.method == "startmovie" and clip.fallback_reason == "图像未生成。"
    assert list(task.output_dir.iterdir()) == [clip.output]


def test_encoder_polling_allows_keyboard_interrupt(monkeypatch):
    class Encoder:
        def poll(self):
            return None

    def cancel(_seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(recording.time, "sleep", cancel)
    with pytest.raises(KeyboardInterrupt):
        recording._wait_for_encoder(Encoder(), timeout=60)
