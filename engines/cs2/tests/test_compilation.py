from contextlib import nullcontext
from pathlib import Path

import pytest

from cs2_engine import compilation
from cs2_engine.compilation import (
    VideoInfo,
    _video_info,
    compilation_argv,
    compilation_clip_argv,
    compile_videos,
)
from cs2_engine.record_task import RecordError


def test_head_and_tail_filters_align_short_segments_on_video_frames():
    argv = compilation_clip_argv(
        Path("ffmpeg.exe"),
        Path("单段 1.mp4"),
        Path("clip-000000.nut"),
        120,
        fade_in=True,
        fade_out=True,
    )
    assert argv[argv.index("-i") + 1] == "单段 1.mp4"
    assert argv[argv.index("-vf") + 1].endswith("fade=t=in:s=0:n=9,fade=t=out:s=111:n=9")
    audio = argv[argv.index("-af") + 1]
    assert "atrim=end_sample=96000" in audio
    assert audio.endswith("afade=t=in:ss=0:ns=7200,afade=t=out:ss=88800:ns=7200")
    assert argv[argv.index("-c:a") + 1] == "pcm_s16le"

    short = compilation_clip_argv(
        Path("ffmpeg.exe"), Path("in.mp4"), Path("out.nut"), 10, fade_in=True, fade_out=True
    )
    assert short[short.index("-vf") + 1].endswith("fade=t=in:s=0:n=5,fade=t=out:s=5:n=5")
    assert short[short.index("-af") + 1].endswith(
        "afade=t=in:ss=0:ns=4000,afade=t=out:ss=4000:ns=4000"
    )


@pytest.mark.parametrize("fade_in, fade_out", [(False, False), (False, True), (True, False)])
def test_only_fades_at_joints(fade_in, fade_out):
    argv = compilation_clip_argv(
        Path("ffmpeg.exe"),
        Path("source.mp4"),
        Path("clip.nut"),
        60,
        fade_in=fade_in,
        fade_out=fade_out,
    )
    for option, name in [("-vf", "fade"), ("-af", "afade")]:
        filters = argv[argv.index(option) + 1]
        assert (f"{name}=t=in" in filters) == fade_in
        assert (f"{name}=t=out" in filters) == fade_out


def test_concat_uses_relative_manifest_and_single_aac_encode(tmp_path):
    manifest = tmp_path / "output folder" / "inputs.ffconcat"
    output = tmp_path / "highlights.mp4"
    argv = compilation_argv(Path("ffmpeg.exe"), manifest, output)
    assert argv[argv.index("-f") + 1 : argv.index("-f") + 6] == [
        "concat",
        "-safe",
        "1",
        "-i",
        "inputs.ffconcat",
    ]
    assert argv[argv.index("-c:v") + 1] == "copy"
    assert argv[argv.index("-c:a") + 1] == "aac"
    assert argv[-1] == str(output)


@pytest.fixture
def probe_metadata():
    return {
        "format": {"duration": "2.000000"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "sample_aspect_ratio": "1:1",
                "avg_frame_rate": "60/1",
                "r_frame_rate": "60/1",
                "nb_frames": "120",
                "start_time": "0.000000",
                "duration": "2.000000",
            },
            {
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "start_time": "0.000000",
                "duration": "1.999000",
            },
        ],
    }


def test_validates_video_and_audio_durations_separately(probe_metadata):
    info = _video_info(probe_metadata)
    assert info == VideoInfo(2, 2, 1.999, 1920, 1080, 60, "1:1", "h264", "aac", 120)


@pytest.mark.parametrize(
    "stream, key, value",
    [
        (0, "width", 1440),
        (0, "sample_aspect_ratio", "4:3"),
        (0, "avg_frame_rate", "30/1"),
        (0, "r_frame_rate", "0/0"),
        (0, "nb_frames", "119"),
        (1, "codec_name", "opus"),
        (1, "duration", "1.5"),
        (1, "duration", "nan"),
        (1, "start_time", "0.1"),
    ],
)
def test_rejects_incompatible_outputs(probe_metadata, stream, key, value):
    probe_metadata["streams"][stream][key] = value
    with pytest.raises(RecordError, match="不符合录制规格"):
        _video_info(probe_metadata)


@pytest.mark.parametrize("failure", [False, True])
def test_compilation_orders_inputs_and_only_publishes_after_probing(tmp_path, monkeypatch, failure):
    scenes = [tmp_path / "scene 2.mp4", tmp_path / "scene 1.mp4"]
    output = tmp_path / "compilation.mp4"
    for path in [*scenes, output]:
        path.write_bytes(b"previous")
    tool = tmp_path / "ffmpeg.exe"
    checked = []

    def probe(_job, _probe, source, _report):
        checked.append(source.name)
        assert output.read_bytes() == b"previous"
        frames = {"scene 2.mp4": 60, "scene 1.mp4": 120, "compilation.mp4": 180}[source.name]
        if source.name == "compilation.mp4" and failure:
            frames -= 1
        duration = frames / 60
        return VideoInfo(duration, duration, duration, 1920, 1080, 60, "1:1", "h264", "aac", frames)

    def run(_job, argv, cwd, _timeout, _failure):
        if "-f" in argv:
            assert (cwd / "inputs.ffconcat").read_text() == (
                "ffconcat version 1.0\n"
                "file clip-000000.nut\nduration 1.00000000\n"
                "file clip-000001.nut\nduration 2.00000000\n"
            )
            Path(argv[-1]).write_bytes(b"new")

    monkeypatch.setattr(compilation, "WindowsJob", nullcontext)
    monkeypatch.setattr(compilation, "_read_video_info", probe)
    monkeypatch.setattr(compilation, "_run", run)
    if failure:
        with pytest.raises(RecordError, match="帧数与单段合计不符"):
            compile_videos(tool, tool, scenes, output)
        assert output.read_bytes() == b"previous"
    else:
        assert compile_videos(tool, tool, scenes, output).frame_count == 180
        assert output.read_bytes() == b"new"
    assert checked == ["scene 2.mp4", "scene 1.mp4", "compilation.mp4"]
    assert all(path.read_bytes() == b"previous" for path in scenes)
