import json
import math
import os
import shutil
import tempfile
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import asdict, replace
from pathlib import Path

from .compilation import _read_video_info
from .disk_space import raw_bytes, require_free_space
from .gameinfo import GameInfoProtection, new_recording_job_name
from .record_task import RecordError, RecordTask
from .recording import (
    CaptureTools,
    RecordedClip,
    _capture_sequence,
    _capture_tools,
    _ensure_cs2_closed,
    _publish_video,
    _recovery_dir,
    _run_encoder,
    _stage_demo,
    _staging_root,
    _verify_writable,
)
from .recording_commands import _CLEAN_HUD, _POV_SCRIPT, _console_path, _validated_target, hlae_argv
from .windows_job import WindowsJob, WindowsProcess

_WRITE_RESERVE = 64 * 1024**2
_MARKER_WRITE_FAILED = "marker-write-failed.xml"


def _write_batch_config(
    profile: Path,
    demo: Path,
    tasks: Sequence[RecordTask],
    captures: Sequence[Path],
    crosshairs: Sequence[bool],
) -> None:
    markers = profile.parent / "markers"
    options = {
        "hud": _CLEAN_HUD,
        "markers": markers.as_posix(),
        "markerWriteFailure": (markers.parent / _MARKER_WRITE_FAILED).as_posix(),
        "clips": [
            {
                "target": _validated_target(task.player_id),
                "start": task.segment.start_tick,
                "end": task.segment.end_tick,
                "death": task.death_tick,
                "nameCommand": f"mirv_streams record name {_console_path(capture)}",
                "crosshair": f"crosshair 1; cl_show_observer_crosshair {2 if crosshair else 0}",
                "xray": f"spec_show_xray {int(task.xray)}",
            }
            for task, capture, crosshair in zip(tasks, captures, crosshairs, strict=True)
        ],
    }
    markers.mkdir()
    folder = profile / "cfg"
    folder.mkdir(parents=True)
    script = folder / "workbench_p3.js"
    script.write_text(
        f"const options = {json.dumps(options)};\n" + _POV_SCRIPT + _BATCH_SCRIPT, encoding="ascii"
    )
    # 沿用 P2 启动命令的 cfg 入口，配置仍只写入本次隔离目录。
    (folder / "workbench_p2.cfg").write_text(
        'mirv_script_load "mirv_script_spec_lock.js"\n'
        f"mirv_script_load {_console_path(script)}\n"
        "demo_ui_mode 0\n"
        f"playdemo {_console_path(demo)}\n",
        encoding="ascii",
    )


def _verify_capture_path(capture: Path) -> None:
    # capture.parent 是建好会话目录时取得的绝对路径。
    if capture.resolve() != capture or capture.is_junction() or capture.is_symlink():
        raise RecordError("OUTPUT_WRITE_FAILED", "录制原始文件目录已被重定向。")


def _verify_raw_writable(capture: Path) -> None:
    # 捕获文件夹尚未创建时检查其父目录。已有录制还要检查保存 TGA/WAV 的子目录。
    _verify_capture_path(capture)
    if not capture.exists():
        _verify_writable(capture.parent)
        return

    def traversal_failed(error: OSError) -> None:
        raise error

    try:
        for directory, children, _ in capture.walk(on_error=traversal_failed):
            children[:] = [name for name in children if not (directory / name).is_junction()]
            _verify_writable(directory)
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法访问批量录制原始文件目录。") from None


def _wait_for_clip(
    job: WindowsJob,
    launch: WindowsProcess,
    markers: Path,
    capture: Path,
    index: int,
    output_dir: Path,
    timeout: float,
) -> bool:
    deadline = time.monotonic() + timeout
    next_space_check = 0.0
    while True:
        now = time.monotonic()
        if (markers.parent / _MARKER_WRITE_FAILED).is_file():
            raise RecordError("OUTPUT_WRITE_FAILED", "HLAE 无法写入批量录制标记。")
        if now >= next_space_check:
            require_free_space(markers, _WRITE_RESERVE)
            require_free_space(output_dir, _WRITE_RESERVE)
            next_space_check = now + 0.25
        for suffix in ("ready", "skip"):
            path = markers / f"{index}.{suffix}"
            try:
                if path.stat().st_size > 0:
                    return suffix == "ready"
            except FileNotFoundError:
                pass
        exited = launch.poll() not in (None, 0) or not job.active_processes()
        if exited or now >= deadline:
            _verify_writable(markers)
            _verify_raw_writable(capture)
            reason = (
                "批量回放在当前片段结束前退出。" if exited else "等待当前片段离线录制结束超时。"
            )
            raise RecordError("RECORD_FAILED", reason)
        time.sleep(0.1)


def _encode_clip(
    tools: CaptureTools, task: RecordTask, capture: Path, output: Path, elapsed: float
) -> RecordedClip:
    raw = _capture_sequence(
        list(capture.rglob("*.tga")) + list(capture.glob("take*/audio.wav")),
        math.ceil(task.segment.duration_s * 60),
        task.capture_size,
        pad_tail=task.death_tick is not None,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="encode-", dir=capture.parent) as encoding:
        temporary = Path(encoding) / "clip.mp4"
        with WindowsJob() as encoder_job:
            duration = _run_encoder(
                encoder_job, tools, raw, temporary, Path(encoding) / "probe.json"
            )
            probe = _read_video_info(
                encoder_job, tools.ffprobe, temporary, Path(encoding) / "full-probe.json"
            )
        size = temporary.stat().st_size
        _publish_video(temporary, output)
    return RecordedClip(
        output,
        "hlae",
        duration,
        elapsed,
        size,
        tail_padding_frames=raw.tail_padding_frames,
        probe=asdict(probe),
    )


def record_multiple(
    items: Sequence[tuple[RecordTask, Path]],
    worker_command: Sequence[str],
    notify: Callable[[str, int, str], None],
    warning: Callable[[str], None],
    *,
    crosshairs: Sequence[bool],
    completed: dict[int, RecordedClip],
) -> dict[int, RecordedClip]:
    """一次离线游戏会话，逐段录制、编码并发布。"""
    if not items:
        return {}
    if os.name != "nt":
        raise RecordError("RECORD_FAILED", "批量录制需要 Windows。")
    first, _ = items[0]
    if first.method == "startmovie":
        return {}

    tools = _capture_tools(first)
    try:
        first.work_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="workbench-cs2-", dir=_staging_root(first.work_dir)
        ) as scratch:
            private = Path(scratch).resolve()
            staged = _stage_demo(first.demo_path, private, 0)
            profile = private / "profile"
            markers = private / "markers"
            captures = [private / f"take-{index:04d}" for index in range(len(items))]
            if not all(crosshairs):
                warning("部分片段未能读取目标准星，使用 CS2 默认准星。")
            _write_batch_config(profile, staged, [task for task, _ in items], captures, crosshairs)
            raw_root = None
            job_name = new_recording_job_name()
            with (
                WindowsJob(job_name) as job,
                GameInfoProtection(
                    tools.gameinfo, _recovery_dir(), worker_command, job_name=job_name
                ),
            ):
                started = None
                try:
                    _ensure_cs2_closed()
                    require_free_space(
                        private, raw_bytes(first.segment.duration_s, first.capture_size)
                    )
                    notify("record", 0, "已校验 gameinfo.gi，正在启动批量离线回放。")
                    started = time.monotonic()
                    try:
                        launch = job.start(
                            hlae_argv(tools.hlae, tools.cs2, profile, aspect=first.aspect),
                            cwd=tools.hlae.parent,
                        )
                    except OSError:
                        raise RecordError("RECORD_FAILED", "无法启动受托管的 CS2 进程。") from None
                    for index, (task, output) in enumerate(items):
                        capture = captures[index]
                        try:
                            ready = _wait_for_clip(
                                job,
                                launch,
                                markers,
                                capture,
                                index,
                                output.parent,
                                max(90, task.segment.duration_s * 8 + 30),
                            )
                        except RecordError as error:
                            if error.code == "OUTPUT_WRITE_FAILED" or not completed:
                                raise
                            warning(f"批量回放未完整退出。{error}")
                            break
                        if ready:
                            _verify_capture_path(capture)
                            try:
                                completed[index] = _encode_clip(
                                    tools, task, capture, output, time.monotonic() - started
                                )
                            except RecordError as error:
                                if error.code == "OUTPUT_WRITE_FAILED":
                                    raise
                                _verify_raw_writable(capture)
                                warning(f"批量回放第 {index + 1} 段未通过校验。{error}")
                        _verify_capture_path(capture)
                        if task.keep_raw and index in completed:
                            new_raw_root = raw_root is None
                            if new_raw_root:
                                raw_root = Path(
                                    tempfile.mkdtemp(prefix="batch-raw-", dir=first.work_dir)
                                )
                            raw_output = raw_root / output.stem
                            try:
                                capture.rename(raw_output)
                            except OSError:
                                if new_raw_root:
                                    with suppress(OSError):
                                        raw_root.rmdir()
                                raise
                            completed[index] = replace(completed[index], raw_output=raw_output)
                        elif capture.exists():
                            shutil.rmtree(capture)
                        clip = completed.get(index)
                        if clip is not None and clip.tail_padding_frames:
                            warning(
                                f"批量回放第 {index + 1} 段"
                                f"补齐了 {clip.tail_padding_frames} 帧末尾画面。"
                            )
                        notify("record", index + 1, f"已处理批量回放第 {index + 1} 段。")
                        if index + 1 < len(items):
                            next_task, _ = items[index + 1]
                            require_free_space(
                                private,
                                raw_bytes(next_task.segment.duration_s, next_task.capture_size),
                            )
                        (markers / f"{index}.continue").touch(exist_ok=False)
                    else:
                        # 给游戏处理最后一次确认及正常退出的机会。超时仍由 Job 清理。
                        deadline = time.monotonic() + 15
                        while job.active_processes() and time.monotonic() < deadline:
                            time.sleep(0.1)
                finally:
                    job.terminate()
                    if started is not None:
                        elapsed = time.monotonic() - started
                        for index, clip in completed.items():
                            completed[index] = replace(clip, capture_elapsed_s=elapsed)
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "批量录制的临时数据或成品无法读写。") from None
    return completed


# 每次跳转保留两秒预滚。停录后进入暂停，等引擎编码、验证和处理原始文件。
_BATCH_SCRIPT = """
let position = -1;
let clip = null;
let phase = "load";
let seek = 0;
let armedAt = -1;
let deadline = 0;
let observedIndex = 0;
let lastView;
let pendingMarker = "";
let acknowledgement;
// The separate, empty campath is a marker writer only and never controls the camera.
const markerWriter = new AdvancedfxCampath();

function marker(suffix) {
    return `${options.markers}/${position}.${suffix}`;
}

function restoreView(event) {
    if (!clip || clip.death === null || !observedIndex ||
        (phase !== "armed" && phase !== "record")) return;
    const view = victimView(clip.death, observedIndex, lastView, event);
    lastView = view.last;
    return view.override;
}

function startNext(tick) {
    position += 1;
    if (position >= options.clips.length) {
        phase = "done";
        mirv.exec("quit");
        return;
    }
    clip = options.clips[position];
    observedIndex = 0;
    lastView = undefined;
    seek = Math.max(0, clip.start - 128);
    phase = "seek";
    deadline = Date.now() + 25000;
    mirv.exec("mirv_script_spec_lock 0; demo_resume");
    if (position > 0 || tick + 1 < seek) mirv.exec(`demo_gototick ${seek}`);
}

function finishClip(recording) {
    phase = "flush";
    deadline = Date.now() + 1000;
    pendingMarker = recording ? "ready" : "skip";
    if (recording) mirv.exec("mirv_streams record end");
    mirv.exec("mirv_script_spec_lock 0; demo_pause");
}

mirv.events.cViewRenderSetupView.on("workbench-p3", restoreView);
mirv.events.clientFrameStageNotify.on("workbench-p3", (event) => {
    if (event.isBefore || phase === "done") return;
    if (phase === "flush") {
        if (Date.now() >= deadline) {
            if (!markerWriter.save(marker(pendingMarker))) {
                markerWriter.save(options.markerWriteFailure);
                phase = "done";
                mirv.exec("quit");
                return;
            }
            acknowledgement = new AdvancedfxPath(marker("continue"));
            phase = "encode";
        }
        return;
    }
    if (phase === "encode") {
        if (Date.now() < deadline) return;
        deadline = Date.now() + 100;
        if (acknowledgement.isFile()) startNext(mirv.getDemoTick());
        return;
    }
    if (!mirv.isPlayingDemo()) {
        if (phase === "record") finishClip(true);
        if (phase === "seek" && Date.now() >= deadline) finishClip(false);
        return;
    }
    const tick = mirv.getDemoTick();
    if (typeof tick !== "number" || tick < 0) return;
    if (phase === "load") {
        if (tick < Math.min(96, Math.max(0, options.clips[0].start - 2))) return;
        mirv.exec("mirv_streams record screen enabled 1; " +
            "mirv_streams record screen settings afxClassic; " +
            "mirv_streams record fps 60; mirv_streams record startMovieWav 1");
        startNext(tick);
        return;
    }
    if (phase === "seek") {
        if (Date.now() >= deadline) { finishClip(false); return; }
        if (tick < seek || tick >= clip.start) return;
        const index = targetIndex(clip.target);
        if (!index) return;
        mirv.exec("sv_cheats 1; hideconsole; volume 1; cl_demo_freecam 0; " +
            "spec_mode 1; cl_demo_predict 1");
        mirv.exec(clip.crosshair);
        mirv.exec(`spec_player ${index}; mirv_script_spec_lock ${index}`);
        mirv.exec(clip.xray);
        mirv.exec(options.hud);
        mirv.exec(clip.nameCommand);
        if (mirv.isDemoPaused()) mirv.exec("demo_resume");
        observedIndex = index;
        armedAt = tick;
        phase = "armed";
        return;
    }
    if (phase === "armed" && tick > armedAt && tick >= clip.start) {
        if (tick > clip.start + 2 || tick >= clip.end || !observing(observedIndex)) {
            finishClip(false);
            return;
        }
        phase = "record";
        mirv.exec(options.hud);
        mirv.exec(clip.crosshair);
        mirv.exec(clip.xray);
        mirv.exec("mirv_streams record start");
    }
    if (phase === "record" && tick >= clip.end) finishClip(true);
});
"""
