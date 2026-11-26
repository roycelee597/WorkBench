import pytest

from cs2_engine import __main__ as cli
from cs2_engine import batch
from cs2_engine.batch_plan import (
    format_highlights,
    number_highlights,
    plan_batch,
    select_highlights,
)
from cs2_engine.models import Demo, Kill, Player, Round
from cs2_engine.record_task import RecordError


def _highlight(round_number: int, start: int, end: int, *types: str) -> dict:
    return {
        "round": round_number,
        "types": list(types),
        "tags": ["3K"],
        "start_tick": start,
        "end_tick": end,
        "duration_s": (end - start) / 64,
        "victim_povs": [],
    }


def _kill(tick: int, victim_id: str | None) -> Kill:
    return Kill(tick, "target", victim_id, 2, 3, "deagle")


def test_numbering_list_and_selection_match_existing_clip_positions():
    original = [
        _highlight(2, 100, 164, "multikill"),
        _highlight(4, 200, 264, "onetap"),
        _highlight(7, 400, 480, "quick_kills", "special"),
    ]
    numbered = number_highlights(original)

    assert all("id" not in item for item in original)
    assert numbered == number_highlights(original)
    assert [item["id"] for item in numbered] == [1, 2, 3]
    assert select_highlights(numbered, "3, 1, 1", False) == [numbered[0], numbered[2]]
    assert select_highlights(numbered, None, True) == numbered
    assert format_highlights(numbered).splitlines() == [
        "编号\t回合\t类型 / 标签\t时长",
        "1\t2\tmultikill / 3K\t1.00 秒",
        "2\t4\tonetap / 3K\t1.00 秒",
        "3\t7\tquick_kills, special / 3K\t1.25 秒",
    ]


@pytest.mark.parametrize("selection", ["", "1,,2", "a", "１", "0,9", "1,8"])
def test_invalid_selection_reports_valid_ids(selection):
    highlights = number_highlights([_highlight(1, 100, 200), _highlight(2, 300, 500)])

    with pytest.raises(RecordError, match="可选编号为 1, 2") as result:
        select_highlights(highlights, selection, False)

    assert result.value.code == "INVALID_TASK"


def test_empty_highlights_has_a_readable_message_and_no_default_selection():
    assert format_highlights([]) == "没有可选高光。"
    with pytest.raises(RecordError, match="没有可选高光"):
        select_highlights([], None, True)


def test_victim_windows_allow_round_end_animation_but_clip_at_next_round_and_demo_end():
    round_one = Round(
        1, 100, 270, 2, kills=(_kill(145, "first"), _kill(270, "bot:9")), clip_end_tick=320
    )
    round_two = Round(2, 300, 420, 2, kills=(_kill(420, "last"),), clip_end_tick=440)
    highlights = number_highlights(
        [_highlight(1, 140, 278, "multikill"), _highlight(2, 370, 438, "onetap")]
    )

    clips = plan_batch(
        Demo(64.0, (), (round_two, round_one)),
        "target",
        list(reversed(highlights)),
        victim_before=1.5,
        victim_after=1,
    )

    players, victims = clips[:2], clips[2:]
    assert [clip.segment.index for clip in players] == [1, 2]
    assert [clip.perspective for clip in clips] == [
        "player",
        "player",
        "victim",
        "victim",
        "victim",
    ]
    assert [(clip.segment.start_tick, clip.segment.end_tick) for clip in victims] == [
        (100, 209),
        (174, 299),
        (324, 440),
    ]
    assert [clip.target_id for clip in victims] == ["first", "bot:9", "last"]
    assert [clip.death_tick for clip in victims] == [145, 270, 420]
    assert [clip.kill_index for clip in victims] == [1, 2, 1]
    assert victims[1].segment.duration_s == (299 - 174) / 64
    assert victims[1].filename == "001-r01-multikill-victim-02.mp4"


def test_overlapping_highlights_include_each_enemy_death_once_and_keep_unknown_victims():
    round_ = Round(
        4,
        20,
        200,
        2,
        kills=(
            _kill(121, "one"),
            _kill(121, "one"),
            _kill(121, "two"),
            Kill(124, "target", "teammate", 2, 2, "deagle"),
            Kill(125, "opponent", "other", 3, 2, "deagle"),
            _kill(130, None),
        ),
        clip_end_tick=245,
    )
    highlights = number_highlights([_highlight(4, 70, 123), _highlight(4, 110, 145)])

    clips = plan_batch(
        Demo(64.0, (), (round_,)),
        "target",
        highlights,
        victim_before=3,
        victim_after=0,
    )

    victims = [clip for clip in clips if clip.perspective == "victim"]
    assert [(clip.target_id, clip.death_tick, clip.segment.index) for clip in victims] == [
        ("one", 121, 1),
        ("two", 121, 1),
        (None, 130, 2),
    ]
    assert all(clip.segment.start_tick == 20 for clip in victims)


@pytest.mark.parametrize("before, after", [(-1, 1), (0, 1), (float("nan"), 1), (1, float("inf"))])
def test_invalid_victim_timing_is_rejected(before, after):
    with pytest.raises(RecordError, match="死亡前秒数须大于零"):
        plan_batch(Demo(64.0, (), ()), "target", [], victim_before=before, victim_after=after)


@pytest.mark.parametrize(
    "flags, xray, windows",
    [
        ([], False, (128, 416)),
        (["--xray"], True, (128, 416)),
        (["--no-xray", "--victim-before", "2", "--victim-after", "0.5"], False, (192, 352)),
    ],
)
@pytest.mark.parametrize(
    "explicit_work, keep_raw, success",
    [(False, False, True), (False, True, True), (True, False, True), (False, False, False)],
    ids=["empty-default", "kept-raw", "explicit-work", "failed-recording"],
)
def test_batch_cli_victim_defaults_xray_and_work_directory(
    tmp_path, monkeypatch, flags, xray, windows, explicit_work, keep_raw, success
):
    player = Player("target", "Synthetic")
    demo = Demo(64.0, (player,), (Round(1, 0, 500, 2, kills=(_kill(320, "victim"),)),))
    monkeypatch.setattr(cli, "_parse_demo", lambda _: demo)
    monkeypatch.setattr(cli, "score_demo", lambda *_args, **_kwargs: [_highlight(1, 250, 350)])
    work = tmp_path / ("work" if explicit_work else ".cs2-work")

    def record_batch(template, clips, *_args):
        assert template.xray is xray
        assert template.work_dir == work
        assert template.output_dir == tmp_path
        assert template.keep_raw is keep_raw
        player_clip, victim_clip = clips
        assert player_clip.perspective == "player"
        assert victim_clip.perspective == "victim"
        assert (victim_clip.segment.start_tick, victim_clip.segment.end_tick) == windows
        assert victim_clip.segment.duration_s == (windows[1] - windows[0]) / 64
        work.mkdir()
        if keep_raw:
            (work / "batch-raw-test").mkdir()
        return {"output_dir": str(tmp_path), "compilations": {"player": {}} if success else {}}

    monkeypatch.setattr(batch, "record_batch", record_batch)
    storage_flags = ["--work-dir", str(work)] if explicit_work else []
    if keep_raw:
        storage_flags.append("--keep-raw")
    assert cli.main(
        [
            "record-batch",
            "--demo",
            str(tmp_path / "demo.dem"),
            "--player",
            "Synthetic",
            "--all",
            "--output-dir",
            str(tmp_path),
            "--cs2-path",
            str(tmp_path),
            "--hlae-path",
            str(tmp_path),
            "--ffmpeg-path",
            str(tmp_path),
            *flags,
            *storage_flags,
        ]
    ) == (0 if success else 1)
    assert work.exists() == (explicit_work or keep_raw or not success)


def test_list_help_explains_which_inspect_numbers_match(capsys):
    with pytest.raises(SystemExit) as result:
        cli.main(["list-highlights", "--help"])

    assert result.value.code == 0
    assert "只与使用默认类型和规则的 inspect 结果一致" in capsys.readouterr().out
