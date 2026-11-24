import json
import os
import struct
import wave
from dataclasses import replace
from pathlib import Path

import pytest

from cs2_engine import __main__ as cli
from cs2_engine import recording
from cs2_engine.batch_capture import _write_batch_config
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
    assert task.aspect == "16:9"
    assert task.xray is False
    assert task.capture_size == (1920, 1080)


@pytest.mark.parametrize(
    "changes, code",
    [
        ({"segment_index": 2}, "INVALID_TASK"),
        ({"segment_index": True}, "INVALID_TASK"),
        ({"player": {"steamid64": "00000000000000002"}}, "PLAYER_NOT_FOUND"),
        ({"resolution": "1440p"}, "INVALID_TASK"),
        ({"aspect": "4:3"}, "INVALID_TASK"),
        ({"aspect": None}, "INVALID_TASK"),
        ({"xray": "true"}, "INVALID_TASK"),
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


@pytest.mark.parametrize("aspect, width", [("16:9", 1920), ("4:3-stretched", 1440)])
def test_hlae_arguments_isolate_game_and_preserve_spaces(aspect, width):
    hlae = Path("Tools with spaces") / "HLAE.exe"
    cs2 = Path("Game with spaces") / "cs2.exe"
    profile = Path("Capture with spaces") / "profile"
    argv = hlae_argv(hlae, cs2, profile, aspect=aspect)
    cmdline = argv[argv.index("-cmdLine") + 1]

    assert argv[argv.index("-programPath") + 1] == str(cs2)
    assert argv[argv.index("-hookDllPath") + 1] == str(hlae.parent / "x64/AfxHookSource2.dll")
    assert argv[argv.index("-addEnv") + 1] == f"USRLOCALCSGO={profile}"
    assert "-noConfig" in argv and "-noGui" in argv
    assert "-insecure" in cmdline and "-afxDisableSteamStorage" in cmdline
    assert "+exec workbench_p2" in cmdline and f"-sw -w {width} -h 1080" in cmdline


@pytest.mark.parametrize(
    "method, start, stop",
    [
        ("hlae", "mirv_streams record start", "mirv_streams record end"),
        ("startmovie", "startmovie wbp2_test", "endmovie; host_framerate 0"),
    ],
)
@pytest.mark.parametrize("observer_crosshair, mode", [(True, 2), (False, 0)])
@pytest.mark.parametrize("xray", [False, True])
def test_generated_config_uses_exact_steamid_and_tick_bounds(
    tmp_path, method, start, stop, observer_crosshair, mode, xray
):
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
        observer_crosshair=observer_crosshair,
        xray=xray,
    )
    cfg = (profile / "cfg/workbench_p2.cfg").read_text(encoding="ascii")
    script = (profile / "cfg/workbench_p2.js").read_text(encoding="ascii")
    settings = json.loads(script.splitlines()[0].removeprefix("const options = ").rstrip(";"))

    assert 'playdemo "demo with spaces.dem"' in cfg
    assert 'mirv_script_load "mirv_script_spec_lock.js"' in cfg
    assert cfg.index("demo_ui_mode 0") < cfg.index("playdemo")
    assert settings["steamid"] == PLAYER
    assert (settings["seek"], settings["start"], settings["end"]) == (872, 1000, 1064)
    assert settings["begin"] == start and settings["stop"] == stop
    assert settings["crosshair"] == f"crosshair 1; cl_show_observer_crosshair {mode}"
    assert settings["xray"] == f"spec_show_xray {int(xray)}"
    assert "getSteamId() === wanted" in script and "spec_mode 1" in script
    hud_commands = settings["hud"].split("; ")
    assert "r_show_build_info 0" in hud_commands
    assert "cl_draw_only_deathnotices 0" in hud_commands
    for panel in (
        "HudDemoController",
        "jsHudSpecplayer__Bg",
        "HudSpecplayer__Avatar",
    ):
        assert f"mirv_panorama panelStyle panelId={panel} opacity=0" in hud_commands
    for panel in (
        "HudTeamCounter",
        "HudWeaponSelection",
        "HudReticle",
        "jsHudHealthArmorAmmoMore",
        "HudDeathNotice",
    ):
        assert f"mirv_panorama panelStyle panelId={panel} opacity=0" not in hud_commands
    assert script.index("mirv.exec(options.hud)") < script.index("mirv.exec(options.begin)")
    assert script.index("mirv.exec(options.crosshair)") < script.index("mirv.exec(options.begin)")
    assert script.rindex("mirv.exec(options.xray)") < script.index("mirv.exec(options.begin)")
    if method == "hlae":
        assert "afxClassic" in settings["setup"] and "startMovieWav 1" in settings["setup"]
    else:
        assert settings["setup"] == "host_framerate 60"


@pytest.mark.parametrize("xray", [False, True])
def test_batch_config_applies_xray_to_human_and_bot_targets(tmp_path, xray):
    task = replace(read_record_task(_task(tmp_path), tmp_path), xray=xray)
    victim = replace(task, player_id="bot:9", death_tick=1020)
    profile = tmp_path / "profile"

    _write_batch_config(
        profile, Path("demo.dem"), [task, victim], [Path("one"), Path("two")], [True, False]
    )

    script = (profile / "cfg/workbench_p3.js").read_text(encoding="ascii")
    settings = json.loads(script.splitlines()[0].removeprefix("const options = ").rstrip(";"))
    assert [(clip["target"], clip["death"], clip["xray"]) for clip in settings["clips"]] == [
        (PLAYER, None, f"spec_show_xray {int(xray)}"),
        ("bot:9", 1020, f"spec_show_xray {int(xray)}"),
    ]
    assert script.rindex("mirv.exec(clip.xray)") < script.index(
        'mirv.exec("mirv_streams record start")'
    )


@pytest.mark.parametrize("target", ["short", "bot:0", "bot:1;quit", "９" * 17])
def test_batch_config_rejects_invalid_targets(tmp_path, target):
    task = replace(read_record_task(_task(tmp_path), tmp_path), player_id=target)
    profile = tmp_path / "profile"

    with pytest.raises(ValueError, match="回放目标无效"):
        _write_batch_config(profile, Path("demo.dem"), [task], [Path("one")], [False])

    assert not profile.exists()


@pytest.mark.parametrize(
    "json_xray, flags, expected",
    [(False, [], False), (True, [], True), (False, ["--xray"], True), (True, ["--no-xray"], False)],
)
def test_single_recording_cli_can_override_task_xray(
    tmp_path, monkeypatch, json_xray, flags, expected
):
    task = {**_task(tmp_path), "xray": json_xray}
    path = tmp_path / "task.json"
    path.write_text(json.dumps(task), encoding="utf-8")
    recorded = []
    monkeypatch.setattr(cli, "run_recording", recorded.append)

    assert cli.main(["run", "--task", str(path), *flags]) == 0

    assert [task.xray for task in recorded] == [expected]


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
            observer_crosshair=True,
        )


def _write_tga_wav(directory: Path, frames=60, *, size=(1920, 1080)) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    frame_bytes = bytearray(24)
    struct.pack_into("<HH", frame_bytes, 12, *size)
    for index in range(frames):
        path = directory / f"{index:05d}.tga"
        path.write_bytes(frame_bytes)
        paths.append(path)
    wav = directory / "audio.wav"
    with wave.open(str(wav), "wb") as audio:
        audio.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x01\x00" * 48000)
    return [*paths, wav]


@pytest.mark.parametrize(
    "source_size, video_filter",
    [
        ((1920, 1080), "setsar=1"),
        ((1440, 1080), "scale=1920:1080:flags=lanczos,setsar=1"),
    ],
)
def test_raw_frames_and_audio_build_explicit_1080p_60fps_ffmpeg_command(
    tmp_path, source_size, video_filter
):
    files = _write_tga_wav(tmp_path / "影片 素材", size=source_size)
    raw = recording._capture_sequence(files, 60, source_size)
    args = recording.ffmpeg_argv(Path("ffmpeg.exe"), raw, tmp_path / "clip.mp4")

    assert args[args.index("-framerate") + 1] == "60"
    assert args[args.index("-start_number") + 1] == "0"
    assert args[args.index("-vf") + 1] == video_filter
    assert "1:a:0" in args and "aac" in args and "libx264" in args
    assert raw.pattern.name == "%05d.tga" and raw.audio.name == "audio.wav"


def test_4_3_capture_rejects_any_widescreen_frame(tmp_path):
    expected_size = (1440, 1080)
    files = _write_tga_wav(tmp_path, size=expected_size)
    frame_bytes = bytearray(files[42].read_bytes())
    struct.pack_into("<HH", frame_bytes, 12, 1920, 1080)
    files[42].write_bytes(frame_bytes)

    with pytest.raises(recording.CaptureIncomplete, match="1920×1080.*1440×1080"):
        recording._capture_sequence(files, 60, expected_size)


def test_victim_capture_pads_a_short_tail_to_its_planned_duration(tmp_path):
    expected_size = (1920, 1080)
    files = _write_tga_wav(tmp_path, frames=59)
    ordinary = recording._capture_sequence(files, 60, expected_size)
    victim = recording._capture_sequence(files, 60, expected_size, pad_tail=True)
    args = recording.ffmpeg_argv(Path("ffmpeg.exe"), victim, tmp_path / "clip.mp4")

    assert ordinary.frame_count == 59 and ordinary.tail_padding_frames == 0
    assert victim.frame_count == 60 and victim.tail_padding_frames == 1
    assert args[args.index("-vf") + 1] == "setsar=1,tpad=stop_mode=clone:stop=1"
    assert args[args.index("-t") + 1] == "1.00000000"
    assert args[args.index("-af") + 1] == "apad"
    with pytest.raises(recording.CaptureIncomplete, match="帧数"):
        recording._capture_sequence([*files[:56], files[-1]], 60, expected_size, pad_tail=True)


def test_incomplete_frames_or_missing_audio_cannot_be_reported_as_a_clip(tmp_path):
    files = _write_tga_wav(tmp_path)
    expected_size = (1920, 1080)
    with pytest.raises(recording.CaptureIncomplete):
        recording._capture_sequence(files[:-1], 60, expected_size)
    with pytest.raises(recording.CaptureIncomplete, match="编号不连续"):
        recording._capture_sequence(files[:5] + files[6:], 60, expected_size)
    with pytest.raises(recording.CaptureIncomplete, match="帧数"):
        recording._capture_sequence(files[:30] + files[-1:], 60, expected_size)


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
    payload["aspect"] = "4:3-stretched"
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
    assert events[-1]["aspect"] == "4:3-stretched"
    assert (events[-1]["source_width"], events[-1]["source_height"]) == (1440, 1080)

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
            observer_crosshair=True,
        )

    assert calls == ["backup", "launch", "terminate", "restore", "close"]


@pytest.mark.skipif(os.name != "nt", reason="单段录制是 Windows 功能")
@pytest.mark.parametrize("observer_crosshair", [True, False])
@pytest.mark.parametrize("precomputed", [True, False])
def test_auto_uses_native_capture_after_incomplete_hlae_and_publishes_one_file(
    tmp_path, monkeypatch, observer_crosshair, precomputed
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
    checks = []
    attempts = []
    warnings = []
    progress_messages = []

    def check_crosshair(demo, player_id, tick):
        assert demo.read_bytes() == task.demo_path.read_bytes()
        assert progress_messages[-1] == "正在读取准星…"
        checks.append((player_id, tick))
        return observer_crosshair

    def attempt(
        _task,
        _tools,
        _demo,
        _directory,
        mp4,
        _state,
        _worker,
        method,
        _notify,
        *,
        observer_crosshair,
    ):
        attempts.append((method, observer_crosshair))
        if method == "hlae":
            raise recording.CaptureIncomplete("图像未生成。")
        mp4.write_bytes(b"synthetic mp4")
        return 1, 2

    monkeypatch.setattr(recording, "has_recorded_crosshair", check_crosshair)
    monkeypatch.setattr(recording, "_record_attempt", attempt)
    clip = recording.record_segment(
        task,
        ["synthetic"],
        lambda _stage, _current, message: progress_messages.append(message),
        warnings.append,
        observer_crosshair=observer_crosshair if precomputed else None,
    )

    assert checks == ([] if precomputed else [(PLAYER, 1000)])
    assert progress_messages.count("正在读取准星…") == (0 if precomputed else 1)
    assert attempts == [("hlae", observer_crosshair), ("startmovie", observer_crosshair)]
    assert sum("默认准星" in message for message in warnings) == (0 if observer_crosshair else 1)
    assert len(warnings) == (1 if observer_crosshair else 2)
    assert "图像未生成" in warnings[-1]
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
