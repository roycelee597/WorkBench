import json
import subprocess
import sys
from pathlib import Path

import pytest

from cs2_engine import __main__ as cli
from cs2_engine.models import AliveState, Demo, Kill, Player, Round
from cs2_engine.parser import DemoParseError

PLAYER_ID = "00000000000000001"
OPPONENT_ID = "00000000000000002"


def make_task(directory: Path, **fields: object) -> Path:
    task_file = directory / "task.json"
    task_file.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mode": "inspect",
                "demo_path": "回放.dem",
                "work_dir": "预览",
                **fields,
            }
        ),
        encoding="utf-8-sig",
    )
    return task_file


def messages(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    output = capsys.readouterr()
    assert not output.err
    return [json.loads(line) for line in output.out.splitlines()]


@pytest.fixture
def synthetic_demo(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Demo:
    demo = Demo(
        64,
        (Player(PLAYER_ID, "目标玩家"), Player(OPPONENT_ID, "对手")),
        (
            Round(
                1,
                100,
                500,
                2,
                (Kill(250, PLAYER_ID, OPPONENT_ID, 2, 3, "knife"),),
                alive_states=(
                    AliveState(100, {2: frozenset({PLAYER_ID}), 3: frozenset({OPPONENT_ID})}),
                ),
            ),
        ),
    )

    def parse(path: Path) -> Demo:
        assert path == tmp_path / "回放.dem"
        return demo

    monkeypatch.setattr(cli, "parse_demo", parse)
    return demo


def test_list_players_without_selecting_player(tmp_path, capsys, synthetic_demo):
    task = make_task(tmp_path)

    assert cli.main(["run", "--task", str(task)]) == 0

    parse_start, parse_complete, result = messages(capsys)
    assert parse_start["stage"] == parse_complete["stage"] == "parse"
    assert result == {
        "type": "result",
        "inspect": {
            "players": [
                {"steamid64": PLAYER_ID, "name": "目标玩家"},
                {"steamid64": OPPONENT_ID, "name": "对手"},
            ],
            "highlights": [],
        },
    }
    parsed = json.loads((tmp_path / "预览" / "parsed.json").read_text(encoding="utf-8"))
    assert parsed["rounds"][0]["alive_states"][0]["players_by_team"]["2"] == [PLAYER_ID]


def test_selected_player_and_overrides_write_preview(tmp_path, capsys, synthetic_demo):
    task = make_task(
        tmp_path,
        player={"steamid64": PLAYER_ID},
        highlights=["knife"],
        rules={"pre_s": 1, "post_s": 0.5},
        victim_pov=True,
    )

    assert cli.main(["run", "--task", str(task)]) == 0

    *progress, result = messages(capsys)
    assert [item["stage"] for item in progress] == ["parse", "parse", "score", "score"]
    preview = result["inspect"]["highlights"][0]
    assert (preview["round"], preview["start_tick"], preview["end_tick"]) == (1, 186, 282)
    assert preview["victim_povs"][0]["steamid64"] == OPPONENT_ID
    assert (
        json.loads((tmp_path / "预览" / "highlights.json").read_text(encoding="utf-8"))
        == result["inspect"]
    )


@pytest.mark.parametrize(
    "fields",
    [
        {"schema_version": True},
        {"mode": "record"},
        {"demo_path": "回放.zip"},
        {"player": {"steamid64": 1}},
        {"highlights": [[]]},
        {"victim_pov": "false"},
        {"rules": {"pre_s": -1}},
    ],
)
def test_rejects_invalid_tasks_without_creating_preview(tmp_path, capsys, fields):
    task = make_task(tmp_path, **fields)

    assert cli.main(["run", "--task", str(task)]) == 1

    (error,) = messages(capsys)
    assert error["type"] == "error"
    assert error["code"] == "INVALID_TASK"
    assert str(tmp_path) not in error["message"]
    assert not (tmp_path / "预览").exists()


def test_missing_player_preserves_existing_preview(tmp_path, capsys, synthetic_demo):
    task = make_task(tmp_path, player={"steamid64": "00000000000000003"})
    work_dir = tmp_path / "预览"
    work_dir.mkdir()
    for filename in ("parsed.json", "highlights.json"):
        (work_dir / filename).write_text("{}", encoding="utf-8")

    assert cli.main(["run", "--task", str(task)]) == 1

    assert messages(capsys)[-1]["code"] == "PLAYER_NOT_FOUND"
    for filename in ("parsed.json", "highlights.json"):
        assert (work_dir / filename).read_text(encoding="utf-8") == "{}"


def test_output_write_failure_gets_structured_error(tmp_path, capsys, synthetic_demo):
    task = make_task(tmp_path)
    (tmp_path / "预览").write_text("文件占用了工作目录路径", encoding="utf-8")

    assert cli.main(["run", "--task", str(task)]) == 1

    assert messages(capsys)[-1]["code"] == "OUTPUT_WRITE_FAILED"


def test_subprocess_keeps_parse_failures_on_json_protocol(tmp_path):
    task = make_task(tmp_path)
    (tmp_path / "回放.dem").write_bytes(b"invalid source 2 demo")

    completed = subprocess.run(
        [sys.executable, "-m", "cs2_engine", "run", "--task", str(task)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 1
    assert not completed.stderr
    error = json.loads(completed.stdout.splitlines()[-1])
    assert error["type"] == "error"
    assert error["code"] == "DEMO_PARSE_FAILED"
    assert str(tmp_path) not in error["message"]


def test_demo_parse_error_is_reported(monkeypatch, tmp_path, capsys):
    def fail(_path):
        raise DemoParseError("无法解析 demo。")

    monkeypatch.setattr(cli, "parse_demo", fail)

    assert cli.main(["run", "--task", str(make_task(tmp_path))]) == 1
    assert messages(capsys)[-1]["code"] == "DEMO_PARSE_FAILED"
