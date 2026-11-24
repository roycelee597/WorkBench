import json
from collections.abc import Callable, Sequence
from dataclasses import asdict, replace
from pathlib import Path
from stat import S_ISREG
from tempfile import TemporaryDirectory, mkdtemp
from time import monotonic

from .batch_capture import record_multiple
from .batch_plan import BatchClip
from .compilation import compile_videos, probe_video
from .parser import recorded_crosshairs
from .record_task import RecordError, RecordTask, validate_record_path
from .recording import RecordedClip, _capture_tools, record_segment

type Notify = Callable[[str, int, int, str], None]


def _clip_fields(clip: BatchClip) -> dict:
    return {
        "id": clip.segment.index,
        "round": clip.round_number,
        "kind": clip.kind,
        "perspective": clip.perspective,
        "kill_index": clip.kill_index,
        "start_tick": clip.segment.start_tick,
        "end_tick": clip.segment.end_tick,
        "death_tick": clip.death_tick,
    }


def _failure(error: RecordError, **fields: object) -> dict:
    return {**fields, "code": error.code, "message": str(error)}


def _clip_path(directory: Path, clip: BatchClip) -> Path:
    return directory / f"{clip.perspective}-clips" / clip.filename


def _recording_order(row: dict) -> tuple:
    return (
        row["perspective"],
        row["death_tick"] if row["death_tick"] is not None else row["start_tick"],
        row["id"],
    )


def _published_size(path: Path) -> int:
    try:
        metadata = path.lstat()
    except OSError:
        return 0
    return metadata.st_size if S_ISREG(metadata.st_mode) else 0


def _capture_cancellation(directory: Path, clips: Sequence[BatchClip], summary: dict) -> None:
    # 成品只有校验通过后才会原子发布。中断若发生在登记结果之前，只确认已发布的路径。
    recordings = summary["segments"]
    known = {row["output"] for row in recordings}
    uncompleted = []
    for clip in clips:
        path = _clip_path(directory, clip)
        if str(path) in known:
            continue
        size = _published_size(path)
        if size:
            recordings.append(
                dict(
                    _clip_fields(clip),
                    output=str(path),
                    recording_method=None,
                    recording_elapsed_s=None,
                    size_bytes=size,
                    probe=None,
                )
            )
        else:
            uncompleted.append(_clip_fields(clip))
    recordings.sort(key=_recording_order)
    for view, filename in (("player", "highlights.mp4"), ("victim", "victims.mp4")):
        path = directory / filename
        if view not in summary["compilations"] and _published_size(path):
            summary["compilations"][view] = {"output": str(path), "probe": None}
    summary.update(cancelled=True, uncompleted=uncompleted)


def _save_summary(directory: Path, summary: dict) -> Path:
    target = directory / "batch-results.json"
    with TemporaryDirectory(prefix=".batch-summary-", dir=directory) as staging:
        temporary = Path(staging) / target.name
        temporary.write_text(
            json.dumps(summary, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8"
        )
        temporary.replace(target)
    return target


def record_batch(
    template: RecordTask,
    clips: Sequence[BatchClip],
    worker_command: Sequence[str],
    notify: Notify,
    warning: Callable[[str], None],
) -> dict:
    """完成能录制的片段，并分别拼接两个视角的成品。"""
    started = monotonic()
    tools = _capture_tools(template)
    try:
        demo_directory = validate_record_path(template.output_dir / template.demo_path.stem)
        demo_directory.mkdir(parents=True, exist_ok=True)
        directory = Path(mkdtemp(prefix="batch-", dir=demo_directory))
        for view in ("player", "victim"):
            (directory / f"{view}-clips").mkdir()
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法创建批量录制输出目录。") from None

    failures = []
    work = []
    for clip in clips:
        if (
            clip.target_id is None
            or clip.segment.start_tick >= clip.segment.end_tick
            or (clip.death_tick is not None and clip.segment.start_tick >= clip.death_tick)
        ):
            failures.append(
                _failure(
                    RecordError("RECORD_FAILED", "片段没有可录制的玩家视角或有效时长。"),
                    **_clip_fields(clip),
                )
            )
            continue
        path = _clip_path(directory, clip)
        task = replace(
            template,
            work_dir=directory,
            output_dir=path.parent,
            segment=clip.segment,
            player_id=clip.target_id,
            death_tick=clip.death_tick,
        )
        work.append((clip, task, path))

    # 按回放时间安排跳转，受害者合集仍按死亡时间排序。
    work.sort(key=lambda item: item[1].segment.start_tick)
    bulk: dict[int, RecordedClip] = {}
    attempted_bulk = len(work) > 1 and template.method != "startmovie"
    recordings = []
    compilations = {}
    retries = 0
    in_bulk = False

    def report() -> dict:
        return {
            "output_dir": str(directory),
            "segments": recordings,
            "compilations": compilations,
            "failures": failures,
            "single_session_attempted": attempted_bulk,
            "single_session_segments": len(bulk),
            "single_session_elapsed_s": max(
                (round(clip.capture_elapsed_s, 3) for clip in bulk.values()), default=None
            ),
            "individual_attempts": retries,
            "elapsed_s": round(monotonic() - started, 3),
        }

    try:
        crosshairs = []
        if work:
            notify("batch-record", 0, len(work), "正在读取准星…")
            targets = [(task.player_id, task.segment.start_tick) for _, task, _ in work]
            available = recorded_crosshairs(template.demo_path, targets)
            crosshairs = [target in available for target in targets]

        if attempted_bulk:
            in_bulk = True
            notify("batch-record", 0, len(work), "正在尝试用一次 CS2 启动录制全部片段。")
            try:
                bulk = record_multiple(
                    [(task, path) for _, task, path in work],
                    worker_command,
                    lambda stage, current, message: notify(stage, current, len(work), message),
                    warning,
                    crosshairs=crosshairs,
                )
            except RecordError as error:
                warning(f"整批录制未完成。{error}将逐段重试。")
            in_bulk = False
            if len(bulk) < len(work):
                warning("未完成的片段将各自重新启动 CS2 录制。")

        # 用计划位置关联不同视角的片段，即使高光编号相同也不会覆盖。
        for index, (clip, task, path) in enumerate(work):
            try:
                output = bulk.get(index)
                if output is None:
                    retries += 1
                    notify("batch-record", index, len(work), f"正在单独录制 {path.stem}。")
                    with TemporaryDirectory(prefix=".clip-", dir=path.parent) as temporary:
                        output = record_segment(
                            replace(task, output_dir=Path(temporary)),
                            worker_command,
                            lambda *_: None,
                            warning,
                            observer_crosshair=crosshairs[index],
                        )
                        verification = probe_video(tools.ffprobe, output.output)
                        output.output.replace(path)
                else:
                    verification = probe_video(tools.ffprobe, output.output)
                recordings.append(
                    {
                        **_clip_fields(clip),
                        "output": str(path),
                        "recording_method": output.method,
                        "recording_elapsed_s": None
                        if index in bulk
                        else round(output.capture_elapsed_s, 3),
                        "size_bytes": output.size_bytes,
                        "probe": asdict(verification),
                    }
                )
            except (RecordError, OSError) as error:
                if isinstance(error, OSError):
                    error = RecordError("OUTPUT_WRITE_FAILED", "无法写入单段成品。")
                failures.append(_failure(error, **_clip_fields(clip)))
                warning(f"{path.stem} 录制失败。{error}")
            notify("batch-record", index + 1, len(work), f"已处理 {index + 1}/{len(work)} 段。")

        recordings.sort(key=_recording_order)
        for view, filename in (("player", "highlights.mp4"), ("victim", "victims.mp4")):
            inputs = [Path(row["output"]) for row in recordings if row["perspective"] == view]
            if not inputs:
                failures.append(
                    _failure(
                        RecordError("COMPILE_FAILED", "没有可拼接的单段成品。"),
                        perspective=view,
                        compilation=filename,
                    )
                )
                continue
            output = directory / filename
            notify("batch-compose", len(compilations), 2, f"正在拼接 {filename}。")
            try:
                probe = compile_videos(tools.ffmpeg, tools.ffprobe, inputs, output)
                compilations[view] = {"output": str(output), "probe": asdict(probe)}
            except RecordError as error:
                failures.append(_failure(error, perspective=view, compilation=filename))
                warning(f"{filename} 拼接失败。{error}")
        results = report()
        try:
            _save_summary(directory, results)
        except OSError:
            raise RecordError("OUTPUT_WRITE_FAILED", "无法写入批量录制汇总。") from None
    except KeyboardInterrupt:
        summary = report()
        if in_bulk:
            summary["single_session_segments"] = sum(
                _published_size(path) > 0 for _, _, path in work
            )
        _capture_cancellation(directory, clips, summary)
        try:
            target = _save_summary(directory, summary)
        except OSError:
            warning("录制已取消，无法写入批量录制汇总。")
        else:
            warning(f"已保存取消时的批量录制汇总。{target}")
        raise
    return results
