import json
import os
from collections.abc import Callable, Sequence
from dataclasses import asdict, replace
from pathlib import Path
from stat import S_ISREG
from tempfile import NamedTemporaryFile, TemporaryDirectory, mkdtemp
from time import monotonic

from .batch_capture import _retain_raw, record_multiple
from .batch_plan import BatchClip
from .compilation import compile_videos, probe_video
from .disk_space import check_recording_space
from .parser import recorded_crosshairs
from .record_task import RecordError, RecordTask, validate_record_path
from .recording import (
    RecordedClip,
    _capture_tools,
    _demo_size,
    _publish_video,
    _staging_root,
    record_segment,
)

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


def _clip_key(row: dict) -> tuple[str, int, int | None]:
    return row["perspective"], row["id"], row["kill_index"]


def _recorded_row(clip: BatchClip, output: RecordedClip, *, bulk: bool) -> dict:
    return {
        **_clip_fields(clip),
        "output": str(output.output),
        "recording_method": output.method,
        "recording_elapsed_s": None if bulk else round(output.capture_elapsed_s, 3),
        "size_bytes": output.size_bytes,
        "tail_padding_frames": output.tail_padding_frames,
        "raw_output": str(output.raw_output) if output.raw_output is not None else None,
        "probe": output.probe,
    }


def _complete_interruption(directory: Path, clips: Sequence[BatchClip], summary: dict) -> None:
    # 成品只有校验通过后才会原子发布。中断若发生在登记结果之前，只确认已发布的路径。
    recordings = summary["segments"]
    known = {row["output"] for row in recordings}
    failed = {_clip_key(row) for row in summary["failures"] if "id" in row}
    uncompleted = []
    for clip in clips:
        path = _clip_path(directory, clip)
        fields = _clip_fields(clip)
        if str(path) in known or _clip_key(fields) in failed:
            continue
        size = _published_size(path)
        if size:
            recordings.append(
                dict(
                    fields,
                    output=str(path),
                    recording_method=None,
                    recording_elapsed_s=None,
                    size_bytes=size,
                    tail_padding_frames=None,
                    raw_output=None,
                    probe=None,
                )
            )
        else:
            uncompleted.append(fields)
    recordings.sort(key=_recording_order)
    for view, filename in (("player", "highlights.mp4"), ("victim", "victims.mp4")):
        path = directory / filename
        if view not in summary["compilations"] and _published_size(path):
            summary["compilations"][view] = {"output": str(path), "probe": None}
    summary["uncompleted"] = uncompleted


def _reserve_summary(directory: Path, count: int) -> Path:
    path = None
    try:
        # 实际写满预留文件，输出卷写满时仍可就地写汇总并原子改名。
        with NamedTemporaryFile(prefix=".batch-summary-", dir=directory, delete=False) as stream:
            path = Path(stream.name)
            block = os.urandom(65536)
            for _ in range((1024**2 + count * 2048 + len(block) - 1) // len(block)):
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if path is not None:
            path.unlink(missing_ok=True)
        raise
    return path


def _save_summary(reserved: Path, target: Path, summary: dict) -> None:
    with reserved.open("r+b") as stream:
        stream.write((json.dumps(summary, ensure_ascii=False, allow_nan=False) + "\n").encode())
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())
    reserved.replace(target)


def _save_interruption(
    reserved: Path, directory: Path, work_dir: Path, summary: dict, warning: Callable[[str], None]
) -> Path | None:
    target = directory / "batch-results.json"
    try:
        _save_summary(reserved, target, summary)
    except OSError:
        # 输出卷无法发布时，在工作卷保留同名汇总，便于找回已有成品。
        try:
            rescue = Path(mkdtemp(prefix=f"{directory.name}-results-", dir=work_dir))
            try:
                temporary = _reserve_summary(rescue, len(summary["uncompleted"]))
                try:
                    target = rescue / target.name
                    _save_summary(temporary, target, summary)
                finally:
                    temporary.unlink(missing_ok=True)
            except OSError:
                rescue.rmdir()
                raise
        except OSError:
            warning("无法在成品盘或工作盘写入批量录制汇总。")
            return None
    warning(f"已保存中断时的批量录制汇总。{target}")
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
    work_dir = _staging_root(template.work_dir)
    demo_directory = validate_record_path(template.output_dir / template.demo_path.stem)
    failures = []
    planned = []
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
        planned.append(clip)
    if planned:
        check_recording_space(
            demo_directory,
            work_dir,
            (clip.segment.duration_s for clip in planned),
            capture_size=template.capture_size,
            demo_bytes=_demo_size(template.demo_path),
            keep_raw=template.keep_raw,
            native_dir=tools.gameinfo.parent if template.method == "startmovie" else None,
        )
    try:
        demo_directory.mkdir(parents=True, exist_ok=True)
        directory = Path(mkdtemp(prefix="batch-", dir=demo_directory))
        work_dir.mkdir(parents=True, exist_ok=True)
        for view in ("player", "victim"):
            (directory / f"{view}-clips").mkdir()
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法创建批量录制输出目录。") from None

    work = []
    for clip in planned:
        path = _clip_path(directory, clip)
        task = replace(
            template,
            work_dir=work_dir,
            output_dir=path.parent,
            segment=clip.segment,
            player_id=clip.target_id,
            death_tick=clip.death_tick,
        )
        work.append((clip, task, path))

    # 按回放时间安排跳转，受害者合集仍按死亡时间排序。
    work.sort(key=lambda item: item[1].segment.start_tick)
    try:
        reserved = _reserve_summary(directory, len(clips))
    except OSError:
        raise RecordError("OUTPUT_WRITE_FAILED", "无法为批量录制汇总预留空间。") from None
    bulk: dict[int, RecordedClip] = {}
    raw_root = work_dir / f"batch-raw-{directory.name.removeprefix('batch-')}"
    attempted_bulk = len(work) > 1 and template.method != "startmovie"
    recordings = []
    compilations = {}
    retries = 0

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
            notify("batch-record", 0, len(work), "正在尝试用一次 CS2 启动录制全部片段。")
            try:
                record_multiple(
                    [(task, path) for _, task, path in work],
                    worker_command,
                    lambda stage, current, message: notify(stage, current, len(work), message),
                    warning,
                    crosshairs=crosshairs,
                    completed=bulk,
                    raw_root=raw_root,
                )
            except RecordError as error:
                if error.code == "OUTPUT_WRITE_FAILED":
                    raise
                warning(f"整批录制未完成。{error}将逐段重试。")
            if len(bulk) < len(work):
                warning("未完成的片段将各自重新启动 CS2 录制。")

        # 用计划位置关联不同视角的片段，即使高光编号相同也不会覆盖。
        for index, (clip, task, path) in enumerate(work):
            try:
                output = bulk.get(index)
                if output is not None:
                    recordings.append(_recorded_row(clip, output, bulk=True))
                else:
                    retries += 1
                    notify("batch-record", index, len(work), f"正在单独录制 {path.stem}。")
                    with TemporaryDirectory(prefix=".retry-", dir=work_dir) as temporary:
                        workspace = Path(temporary)
                        output = record_segment(
                            replace(task, work_dir=workspace, output_dir=workspace),
                            worker_command,
                            lambda *_: None,
                            warning,
                            observer_crosshair=crosshairs[index],
                        )
                        verification = probe_video(tools.ffprobe, output.output, work_dir=workspace)
                        _publish_video(output.output, path)
                        row = _recorded_row(
                            clip,
                            replace(
                                output, output=path, raw_output=None, probe=asdict(verification)
                            ),
                            bulk=False,
                        )
                        recordings.append(row)
                        if output.tail_padding_frames:
                            warning(f"{path.stem} 已在片尾补齐 {output.tail_padding_frames} 帧。")
                        if output.raw_output is not None:
                            retained = _retain_raw(output.raw_output, raw_root, path)
                            row["raw_output"] = str(retained)
            except (RecordError, OSError) as error:
                if isinstance(error, OSError):
                    error = RecordError("OUTPUT_WRITE_FAILED", "无法写入单段成品。")
                if not _published_size(path):
                    failures.append(_failure(error, **_clip_fields(clip)))
                warning(f"{path.stem} 录制失败。{error}")
                if error.code == "OUTPUT_WRITE_FAILED":
                    raise error from None
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
                probe = compile_videos(
                    tools.ffmpeg, tools.ffprobe, inputs, output, work_dir=work_dir
                )
                compilations[view] = {"output": str(output), "probe": asdict(probe)}
            except RecordError as error:
                failures.append(_failure(error, perspective=view, compilation=filename))
                warning(f"{filename} 拼接失败。{error}")
                if error.code == "OUTPUT_WRITE_FAILED":
                    raise
        results = report()
        _save_summary(reserved, directory / "batch-results.json", results)
    except (KeyboardInterrupt, RecordError, OSError) as error:
        if isinstance(error, RecordError) and error.code != "OUTPUT_WRITE_FAILED":
            raise
        saved_paths = {row["output"] for row in recordings}
        recordings.extend(
            _recorded_row(work[index][0], output, bulk=True)
            for index, output in bulk.items()
            if str(output.output) not in saved_paths
        )
        summary = report()
        summary["cancelled"] = isinstance(error, KeyboardInterrupt)
        if not summary["cancelled"]:
            summary["error"] = _failure(
                error
                if isinstance(error, RecordError)
                else RecordError(
                    "OUTPUT_WRITE_FAILED", "批量录制文件写入失败，已停止处理后续片段。"
                )
            )
        _complete_interruption(directory, clips, summary)
        target = _save_interruption(reserved, directory, work_dir, summary, warning)
        if summary["cancelled"]:
            raise
        results = {**summary, "summary": str(target) if target is not None else None}
    finally:
        try:
            reserved.unlink(missing_ok=True)
        except OSError:
            warning("无法清理成品目录里的批次汇总预留文件。")
    return results
