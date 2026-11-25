from collections.abc import Sequence
from dataclasses import dataclass
from math import ceil, isfinite
from typing import Literal

from .models import Demo
from .record_task import RecordError, Segment
from .scoring import _clip_end, _enemy_kills, _tick_distance


@dataclass(frozen=True, slots=True)
class BatchClip:
    perspective: Literal["player", "victim"]
    segment: Segment
    round_number: int
    kind: str
    target_id: str | None
    kill_index: int | None = None
    death_tick: int | None = None

    @property
    def filename(self) -> str:
        stem = f"{self.segment.index:03d}-r{self.round_number:02d}-{self.kind}"
        if self.kill_index is not None:
            stem += f"-victim-{self.kill_index:02d}"
        return stem + ".mp4"


def number_highlights(highlights: Sequence[dict]) -> list[dict]:
    """沿用 P1 原有顺序，使批量编号与已有单段录制编号一致。"""
    return [dict(highlight, id=index) for index, highlight in enumerate(highlights, 1)]


def format_highlights(highlights: Sequence[dict]) -> str:
    if not highlights:
        return "没有可选高光。"

    lines = ["编号\t回合\t类型 / 标签\t时长"]
    for highlight in highlights:
        types = ", ".join(highlight["types"]) or "—"
        tags = ", ".join(highlight["tags"]) or "—"
        lines.append(
            f"{highlight['id']}\t{highlight['round']}\t{types} / {tags}"
            f"\t{highlight['duration_s']:.2f} 秒"
        )
    return "\n".join(lines)


def select_highlights(highlights: Sequence[dict], selection: str | None, all_: bool) -> list[dict]:
    available = {highlight["id"] for highlight in highlights}
    if not available:
        raise RecordError("INVALID_TASK", "没有可选高光。")

    available_text = ", ".join(str(index) for index in sorted(available))
    if all_ and selection is None:
        return list(highlights)
    if selection is None or all_:
        raise RecordError(
            "INVALID_TASK", f"请指定 --select 或 --all。可选编号为 {available_text}。"
        )

    fields = [field.strip() for field in selection.split(",")]
    if any(not field.isascii() or not field.isdecimal() for field in fields):
        raise RecordError(
            "INVALID_TASK", f"请用逗号分隔有效的高光编号。可选编号为 {available_text}。"
        )
    try:
        requested = {int(field) for field in fields}
    except ValueError:
        raise RecordError("INVALID_TASK", f"高光编号过长。可选编号为 {available_text}。") from None
    unknown = requested - available
    if unknown:
        detail = ", ".join(str(index) for index in sorted(unknown))
        raise RecordError("INVALID_TASK", f"无效高光编号 {detail}。可选编号为 {available_text}。")
    return [highlight for highlight in highlights if highlight["id"] in requested]


def plan_batch(
    demo: Demo,
    player_id: str,
    selected: Sequence[dict],
    *,
    victim_before: float,
    victim_after: float,
) -> tuple[BatchClip, ...]:
    rate = demo.tick_rate
    if not isfinite(rate) or rate <= 0:
        raise RecordError("INVALID_TASK", "demo 的 tick 频率必须大于零。")
    if (
        not isfinite(victim_before)
        or not isfinite(victim_after)
        or victim_before <= 0
        or victim_after < 0
    ):
        raise RecordError("INVALID_TASK", "死亡前秒数须大于零，死亡后秒数须为非负数。")

    before = ceil(_tick_distance(victim_before, rate))
    after = ceil(_tick_distance(victim_after, rate))
    rounds = sorted(demo.rounds, key=lambda round_: round_.start_tick)
    end_limits = {
        round_.start_tick: min(_clip_end(round_), rounds[index + 1].start_tick - 1)
        if index + 1 < len(rounds)
        else _clip_end(round_)
        for index, round_ in enumerate(rounds)
    }

    player_clips = []
    victim_clips = []
    seen: set[tuple[int, int]] = set()
    for highlight in sorted(selected, key=lambda item: (item["start_tick"], item["id"])):
        number, round_number = highlight["id"], highlight["round"]
        start, end = highlight["start_tick"], highlight["end_tick"]
        kind = "-".join(highlight["types"]) or "highlight"
        round_ = next(
            (
                candidate
                for candidate in rounds
                if candidate.number == round_number
                and candidate.start_tick <= start <= _clip_end(candidate)
            ),
            None,
        )
        if round_ is None:
            raise RecordError("INVALID_TASK", f"高光 {number} 与 demo 的回合边界不符。")
        player_clips.append(
            BatchClip(
                "player",
                Segment(number, start, end, (end - start) / rate),
                round_number,
                kind,
                player_id,
            )
        )
        kills = [
            (index, kill)
            for index, kill in enumerate(_enemy_kills(round_, player_id))
            if start <= kill.tick <= end
        ]
        for ordinal, (index, kill) in enumerate(kills, 1):
            key = (round_.start_tick, index)
            if key in seen:
                continue
            seen.add(key)
            victim_start = max(0, round_.start_tick, kill.tick - before)
            victim_end = min(end_limits[round_.start_tick], kill.tick + after)
            victim_clips.append(
                BatchClip(
                    "victim",
                    Segment(number, victim_start, victim_end, (victim_end - victim_start) / rate),
                    round_number,
                    kind,
                    kill.victim_id,
                    ordinal,
                    kill.tick,
                )
            )

    victim_clips.sort(key=lambda clip: (clip.death_tick or 0, clip.segment.index))
    return (*player_clips, *victim_clips)
