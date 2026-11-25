import argparse
import json
import sys
import traceback
from collections.abc import Sequence
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from tempfile import NamedTemporaryFile

from .batch_plan import format_highlights, number_highlights, plan_batch, select_highlights
from .gameinfo import GameInfoError, run_gameinfo_watchdog
from .models import Demo
from .parser import DemoParseError, parse_demo
from .record_task import (
    WORK_SUBDIR,
    RecordError,
    RecordTask,
    read_record_task,
    validate_record_path,
)
from .recording import record_segment, recover_recording
from .rules import HIGHLIGHT_TYPES, Rules, parse_rules
from .scoring import score_demo


class InspectError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class InspectTask:
    demo_path: Path
    work_dir: Path
    player_id: str | None
    highlights: tuple[str, ...]
    rules: Rules
    victim_pov: bool


def task_path_field(task: dict, key: str, directory: Path) -> Path:
    value = task.get(key)
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError(f"{key} 必须是有效路径。")
    return directory / value


def read_task(path: Path) -> InspectTask | RecordTask:
    try:
        path = validate_record_path(path)
        task = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise InspectError("INVALID_TASK", "无法读取任务文件，请提供有效的 JSON 文件。") from None

    try:
        if not isinstance(task, dict) or type(task.get("schema_version")) is not int:
            raise ValueError("任务必须包含整数 schema_version。")
        if task["schema_version"] != 1 or task.get("mode") not in ("inspect", "record"):
            raise ValueError("当前引擎支持 schema_version 为 1 的 inspect 和 record 任务。")
        if task["mode"] == "record":
            return read_record_task(task, path.parent)

        demo_path = task_path_field(task, "demo_path", path.parent)
        if demo_path.suffix.lower() != ".dem":
            raise ValueError("demo_path 必须指向解压后的 .dem 文件。")
        work_dir = task_path_field(task, "work_dir", path.parent)
        if path.resolve() in {
            (work_dir / name).resolve() for name in ("parsed.json", "highlights.json")
        }:
            raise ValueError("任务文件名与工作目录中的输出文件冲突。")

        player_id = None
        player = task.get("player")
        if player is not None:
            steamid64 = player.get("steamid64") if isinstance(player, dict) else None
            if (
                not isinstance(steamid64, str)
                or len(steamid64) != 17
                or not steamid64.isascii()
                or not steamid64.isdecimal()
            ):
                raise ValueError("player.steamid64 必须是由 17 位数字组成的字符串。")
            player_id = steamid64

        highlights = task.get("highlights", list(HIGHLIGHT_TYPES))
        if not isinstance(highlights, list) or any(
            not isinstance(kind, str) or kind not in HIGHLIGHT_TYPES for kind in highlights
        ):
            raise ValueError("highlights 必须是由已知高光类型组成的数组。")
        victim_pov = task.get("victim_pov", False)
        if not isinstance(victim_pov, bool):
            raise ValueError("victim_pov 必须是布尔值。")
        rules = parse_rules(task.get("rules", {}))
    except ValueError as error:
        raise InspectError("INVALID_TASK", str(error)) from None
    except (OSError, RuntimeError):
        raise InspectError("INVALID_TASK", "无法解析任务中的路径。") from None

    return InspectTask(demo_path, work_dir, player_id, tuple(highlights), rules, victim_pov)


def json_default(value: object) -> list[str]:
    if isinstance(value, frozenset):
        return sorted(value)
    raise TypeError("输出包含无法写入 JSON 的数据。")


def write_result(path: Path, result: dict) -> None:
    temporary_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # 写完后再替换目标文件，避免失败时留下截断的 JSON。
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(
                result, temporary_file, ensure_ascii=False, default=json_default, allow_nan=False
            )
            temporary_file.write("\n")
        temporary_path.replace(path)
    except OSError:
        raise InspectError("OUTPUT_WRITE_FAILED", "无法写入工作目录中的预览文件。") from None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def emit(message_type: str, **fields: object) -> None:
    print(json.dumps({"type": message_type, **fields}, allow_nan=False), flush=True)


def progress(stage: str, current: int, message: str, *, segment_id: int | None = None) -> None:
    emit("progress", stage=stage, current=current, total=1, message=message, segment_id=segment_id)


def _parse_demo(path: Path) -> Demo:
    try:
        return parse_demo(path)
    except DemoParseError as error:
        raise InspectError("DEMO_PARSE_FAILED", str(error)) from None


def inspect_demo(task: InspectTask) -> None:
    progress("parse", 0, "正在解析 demo。")
    demo = _parse_demo(task.demo_path)
    progress("parse", 1, "demo 解析完成。")

    players = [asdict(player) for player in demo.players]
    highlights = []
    if task.player_id is not None:
        if not any(player.steamid64 == task.player_id for player in demo.players):
            raise InspectError("PLAYER_NOT_FOUND", "demo 里没有找到所选玩家。")
        progress("score", 0, "正在计算高光。")
        highlights = number_highlights(
            score_demo(
                demo, task.player_id, task.highlights, task.rules, victim_pov=task.victim_pov
            )
        )
    result = {"players": players, "highlights": highlights}
    write_result(task.work_dir / "parsed.json", asdict(demo))
    write_result(task.work_dir / "highlights.json", result)
    if task.player_id is not None:
        progress("score", 1, "高光计算完成。")
    emit("result", inspect=result)


def _worker_command() -> list[str]:
    command = [sys.executable]
    if not getattr(sys, "frozen", False):
        command.extend(("-m", "cs2_engine"))
    return command


def _warning(message: str) -> None:
    emit("log", level="warning", message=message)


def run_recording(task: RecordTask) -> None:

    def report(stage: str, current: int, message: str) -> None:
        progress(stage, current, message, segment_id=task.segment.index)

    clip = record_segment(task, _worker_command(), report, _warning)
    width, height = task.capture_size
    result = {
        "output": str(clip.output),
        "aspect": task.aspect,
        "source_width": width,
        "source_height": height,
        "duration_s": clip.duration_s,
        "recording_method": clip.method,
        "recording_elapsed_s": round(clip.capture_elapsed_s, 3),
        "size_bytes": clip.size_bytes,
        "tail_padding_frames": clip.tail_padding_frames,
        "raw_output": str(clip.raw_output) if clip.raw_output is not None else None,
        "gameinfo_restored": True,
        "fallback_reason": clip.fallback_reason,
    }
    write_result(
        task.work_dir / "segments.json", {"segments": [{**asdict(task.segment), **result}]}
    )
    emit("done", segments=1, **result)


def _batch_player(demo: Demo, value: str) -> str:
    for player in demo.players:
        if player.steamid64 == value:
            return player.steamid64
    matches = [player.steamid64 for player in demo.players if player.name == value]
    if len(matches) > 1:
        raise InspectError("PLAYER_NOT_FOUND", "存在同名玩家，请改用 SteamID64。")
    if not matches:
        raise InspectError("PLAYER_NOT_FOUND", "demo 里没有找到指定玩家。")
    return matches[0]


def run_batch_command(args: argparse.Namespace) -> int:
    path = validate_record_path(args.demo)
    if path.suffix.lower() != ".dem":
        raise RecordError("INVALID_TASK", "--demo 必须指向解压后的 .dem 文件。")
    if args.command == "record-batch":
        progress("parse", 0, "正在解析 demo 并计算高光。")
    demo = _parse_demo(path)
    player = _batch_player(demo, args.player)
    highlights = number_highlights(
        score_demo(demo, player, HIGHLIGHT_TYPES, Rules(), victim_pov=False)
    )
    if args.command == "list-highlights":
        print(format_highlights(highlights))
        return 0

    from .batch import record_batch

    clips = plan_batch(
        demo,
        player,
        select_highlights(highlights, args.select, args.all),
        victim_before=args.victim_before,
        victim_after=args.victim_after,
    )
    destination = validate_record_path(args.output_dir)
    template = RecordTask(
        demo_path=path,
        work_dir=validate_record_path(args.work_dir or destination / WORK_SUBDIR),
        output_dir=destination,
        cs2_path=validate_record_path(args.cs2_path),
        hlae_path=validate_record_path(args.hlae_path),
        ffmpeg_path=validate_record_path(args.ffmpeg_path),
        player_id=player,
        segment=clips[0].segment,
        method=args.recording_method,
        aspect=args.aspect,
        xray=args.xray,
        keep_raw=args.keep_raw,
    )

    def report(stage: str, current: int, total: int, message: str) -> None:
        emit("progress", stage=stage, current=current, total=total, message=message)

    results = record_batch(template, clips, _worker_command(), report, _warning)
    summary = results.pop("summary", str(Path(results["output_dir"]) / "batch-results.json"))
    if error := results.get("error"):
        emit("error", **error, summary=summary)
        return 1
    if not results["compilations"]:
        emit("error", code="BATCH_FAILED", message="没有可用的合集成品。", summary=str(summary))
        return 1
    emit("done", **results, summary=str(summary))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cs2-engine", description="解析 CS2 demo 并录制高光合集。"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="读取任务 JSON。")
    run.add_argument("--task", required=True, type=Path, help="任务 JSON 文件路径")
    listing = commands.add_parser(
        "list-highlights",
        help="列出高光编号与时长。",
        description="列出高光编号与时长。编号只与使用默认类型和规则的 inspect 结果一致。",
    )
    batch = commands.add_parser("record-batch", help="批量录制并生成两个视角的合集。")
    for command in (run, batch):
        command.add_argument(
            "--xray",
            action=argparse.BooleanOptionalAction,
            default=None if command is run else False,
            help="开启或关闭录制中的观战 X 光，默认关闭。",
        )
    for command in (listing, batch):
        command.add_argument("--demo", required=True, type=Path, help="CS2 .dem 文件")
        command.add_argument("--player", required=True, help="SteamID64 或完整玩家名")
    selection = batch.add_mutually_exclusive_group(required=True)
    selection.add_argument("--select", help="用逗号分隔的高光编号，例如 1,3,5")
    selection.add_argument("--all", action="store_true", help="录制所选玩家的全部高光")
    batch.add_argument("--output-dir", "--out", required=True, type=Path, help="批量成品目录")
    run.add_argument("--output-dir", "--out", type=Path, help="覆盖单段录制成品目录")
    for command in (run, batch):
        command.add_argument(
            "--work-dir", type=Path, help="录制工作目录，默认使用成品目录下的 .cs2-work"
        )
        command.add_argument(
            "--keep-raw",
            action="store_true",
            default=None if command is run else False,
            help="保留已完成片段的 TGA 和 WAV 原始文件",
        )
    batch.add_argument("--cs2-path", required=True, type=Path, help="CS2 安装目录或 cs2.exe")
    batch.add_argument("--hlae-path", required=True, type=Path, help="HLAE.exe")
    batch.add_argument("--ffmpeg-path", required=True, type=Path, help="FFmpeg.exe")
    batch.add_argument("--aspect", choices=("16:9", "4:3-stretched"), default="16:9")
    batch.add_argument("--recording-method", choices=("auto", "hlae", "startmovie"), default="auto")
    batch.add_argument("--victim-before", type=float, default=3, help="死亡前的秒数，默认 3")
    batch.add_argument("--victim-after", type=float, default=1.5, help="死亡后的秒数，默认 1.5")
    recover = commands.add_parser("recover-gameinfo", help="从本机记录恢复 CS2 的 gameinfo.gi。")
    recover.add_argument("--cs2-path", required=True, type=Path, help="CS2 安装目录或 cs2.exe")
    recover.add_argument(
        "--accept-current",
        action="store_true",
        help="在 Steam 验证游戏文件后，保留当前 gameinfo.gi 并清除旧备份。",
    )
    watchdog = commands.add_parser("gameinfo-watchdog")
    watchdog.add_argument("--gameinfo", required=True, type=Path)
    watchdog.add_argument("--state-dir", required=True, type=Path)
    watchdog.add_argument("--job-name")
    args = parser.parse_args(argv)
    if args.command == "gameinfo-watchdog":
        try:
            return run_gameinfo_watchdog(
                validate_record_path(args.gameinfo),
                validate_record_path(args.state_dir),
                args.job_name,
            )
        except (RecordError, OSError, RuntimeError):
            return 1
    try:
        if args.command == "recover-gameinfo":
            handled = recover_recording(args.cs2_path, accept_current=args.accept_current)
            emit("result", recovery={"restored": handled})
        elif args.command in ("list-highlights", "record-batch"):
            return run_batch_command(args)
        else:
            task = read_task(args.task)
            if isinstance(task, RecordTask):
                output = (
                    validate_record_path(args.output_dir) if args.output_dir else task.output_dir
                )
                work = args.work_dir or task.work_dir
                if args.output_dir and not args.work_dir and work == task.output_dir / WORK_SUBDIR:
                    work = output / WORK_SUBDIR
                task = replace(
                    task,
                    output_dir=output,
                    work_dir=validate_record_path(work),
                    xray=task.xray if args.xray is None else args.xray,
                    keep_raw=task.keep_raw if args.keep_raw is None else args.keep_raw,
                )
                run_recording(task)
            else:
                if any(
                    option is not None
                    for option in (args.xray, args.output_dir, args.work_dir, args.keep_raw)
                ):
                    raise InspectError("INVALID_TASK", "命令行录制选项仅用于录制任务。")
                inspect_demo(task)
    except (InspectError, RecordError) as error:
        emit("error", code=error.code, message=str(error))
        return 1
    except GameInfoError as error:
        emit("error", code="GAMEINFO_FAILED", message=str(error))
        return 1
    except KeyboardInterrupt:
        emit("error", code="CANCELLED", message="任务已取消。")
        return 1
    except Exception:
        emit("error", code="INTERNAL_ERROR", message="引擎内部错误，请查看日志")
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
