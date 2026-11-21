import argparse
import json
import sys
import traceback
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile

from .parser import DemoParseError, parse_demo
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


def read_task(path: Path) -> InspectTask:
    try:
        task = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise InspectError("INVALID_TASK", "无法读取任务文件，请提供有效的 JSON 文件。") from None

    try:
        if not isinstance(task, dict) or type(task.get("schema_version")) is not int:
            raise ValueError("任务必须包含整数 schema_version。")
        if task["schema_version"] != 1 or task.get("mode") != "inspect":
            raise ValueError("当前引擎只支持 schema_version 为 1 的 inspect 任务。")

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


def progress(stage: str, current: int, message: str) -> None:
    emit("progress", stage=stage, current=current, total=1, message=message, segment_id=None)


def inspect_demo(task: InspectTask) -> None:
    progress("parse", 0, "正在解析 demo。")
    try:
        demo = parse_demo(task.demo_path)
    except DemoParseError as error:
        raise InspectError("DEMO_PARSE_FAILED", str(error)) from None
    progress("parse", 1, "demo 解析完成。")

    players = [asdict(player) for player in demo.players]
    highlights = []
    if task.player_id is not None:
        if not any(player.steamid64 == task.player_id for player in demo.players):
            raise InspectError("PLAYER_NOT_FOUND", "demo 里没有找到所选玩家。")
        progress("score", 0, "正在计算高光。")
        highlights = score_demo(
            demo, task.player_id, task.highlights, task.rules, victim_pov=task.victim_pov
        )
    result = {"players": players, "highlights": highlights}
    write_result(task.work_dir / "parsed.json", asdict(demo))
    write_result(task.work_dir / "highlights.json", result)
    if task.player_id is not None:
        progress("score", 1, "高光计算完成。")
    emit("result", inspect=result)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cs2-engine", description="解析 CS2 demo 并预览高光。")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="读取任务 JSON。")
    run.add_argument("--task", required=True, type=Path, help="任务 JSON 文件路径")
    args = parser.parse_args(argv)
    try:
        inspect_demo(read_task(args.task))
    except InspectError as error:
        emit("error", code=error.code, message=str(error))
        return 1
    except KeyboardInterrupt:
        emit("error", code="CANCELLED", message="已取消预览。")
        return 1
    except Exception:
        emit("error", code="INTERNAL_ERROR", message="引擎内部错误，请查看日志")
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
