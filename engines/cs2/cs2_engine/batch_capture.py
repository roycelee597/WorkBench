import json
import math
import os
import tempfile
import time
from collections.abc import Callable, Sequence
from pathlib import Path

from .compilation import _read_video_info
from .gameinfo import GameInfoProtection, new_recording_job_name
from .record_task import RecordError, RecordTask
from .recording import (
    RecordedClip,
    _capture_sequence,
    _capture_tools,
    _ensure_cs2_closed,
    _recovery_dir,
    _run_encoder,
    _stage_demo,
    _staging_root,
    _wait_for_game,
)
from .recording_commands import _CLEAN_HUD, _POV_SCRIPT, _console_path, _validated_target
from .windows_job import WindowsJob


def _write_batch_config(
    profile: Path,
    demo: Path,
    tasks: Sequence[RecordTask],
    captures: Sequence[Path],
    crosshairs: Sequence[bool],
) -> None:
    options = {
        "hud": _CLEAN_HUD,
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


def record_multiple(
    items: Sequence[tuple[RecordTask, Path]],
    worker_command: Sequence[str],
    notify: Callable[[str, int, str], None],
    warning: Callable[[str], None],
    *,
    crosshairs: Sequence[bool],
) -> dict[int, RecordedClip]:
    """保护一次离线游戏会话，逐段独立验证已完成的录制。"""
    if not items:
        return {}
    if os.name != "nt":
        raise RecordError("RECORD_FAILED", "批量录制需要 Windows。")
    first, _ = items[0]
    if first.method == "startmovie":
        return {}

    tools = _capture_tools(first)
    frames = [math.ceil(task.segment.duration_s * 60) for task, _ in items]
    width, height = first.capture_size
    required = sum(frames) * width * height * 4 + len(items) * 64 * 1024**2
    completed = {}
    try:
        first.work_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="workbench-cs2-", dir=_staging_root(first.work_dir)
        ) as scratch:
            private = Path(scratch)
            staged = _stage_demo(first.demo_path, private, required)
            profile = private / "profile"
            captures = [private / f"take-{index:04d}" for index in range(len(items))]
            if not all(crosshairs):
                warning("部分片段未能读取目标准星，使用 CS2 默认准星。")
            _write_batch_config(profile, staged, [task for task, _ in items], captures, crosshairs)
            job_name = new_recording_job_name()
            with (
                WindowsJob(job_name) as job,
                GameInfoProtection(
                    tools.gameinfo, _recovery_dir(), worker_command, job_name=job_name
                ),
            ):
                try:
                    _ensure_cs2_closed()
                    notify("record", 0, "已校验 gameinfo.gi，正在启动批量离线回放。")
                    started = time.monotonic()
                    session_error = None
                    try:
                        _wait_for_game(job, tools, profile, max(180, sum(frames) * 3), first.aspect)
                    except RecordError as error:
                        session_error = error
                        warning(f"批量回放未完整退出。{error}")
                    elapsed = time.monotonic() - started
                finally:
                    job.terminate()
            # 游戏结束并完成恢复后，每段编码使用独立的 Job。即使游戏超时，
            # 此前已写完的片段仍能编码，单段卡住也不会影响下一段。
            for index, (task, output) in enumerate(items):
                capture = captures[index]
                try:
                    raw = _capture_sequence(
                        list(capture.rglob("*.tga")) + list(capture.glob("take*/audio.wav")),
                        frames[index],
                        first.capture_size,
                        pad_tail=task.death_tick is not None,
                    )
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(
                        prefix=".cs2-output-", dir=output.parent
                    ) as encoding:
                        temporary = Path(encoding) / "clip.mp4"
                        with WindowsJob() as encoder_job:
                            duration = _run_encoder(
                                encoder_job, tools, raw, temporary, Path(encoding) / "probe.json"
                            )
                            _read_video_info(
                                encoder_job,
                                tools.ffprobe,
                                temporary,
                                Path(encoding) / "full-probe.json",
                            )
                        size = temporary.stat().st_size
                        temporary.replace(output)
                        completed[index] = RecordedClip(output, "hlae", duration, elapsed, size)
                except RecordError as error:
                    warning(f"批量回放第 {index + 1} 段未通过校验。{error}")
                except OSError:
                    warning(f"批量回放第 {index + 1} 段的临时文件或成品无法读写。")
                notify("record", index + 1, f"已处理批量回放第 {index + 1} 段。")
            if not completed and session_error is not None:
                raise session_error
    except OSError:
        if completed:
            warning("批量录制的临时目录未能完全清理，已验证的成品已保留。")
            return completed
        raise RecordError("OUTPUT_WRITE_FAILED", "批量录制的临时数据或成品无法读写。") from None
    return completed


# 每次跳转保留两秒预滚，结束后先停录并等待音频文件写完。
_BATCH_SCRIPT = """
let position = -1;
let clip = null;
let phase = "load";
let seek = 0;
let armedAt = -1;
let deadline = 0;
let observedIndex = 0;
let lastView;

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
    if (recording) mirv.exec("mirv_streams record end");
    mirv.exec("mirv_script_spec_lock 0; demo_pause");
}

mirv.events.cViewRenderSetupView.on("workbench-p3", restoreView);
mirv.events.clientFrameStageNotify.on("workbench-p3", (event) => {
    if (event.isBefore || phase === "done") return;
    if (phase === "flush") {
        if (Date.now() >= deadline) startNext(mirv.getDemoTick());
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
