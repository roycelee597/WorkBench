import json
import re
import subprocess
from pathlib import Path
from typing import Literal

from .record_task import CAPTURE_SIZES, CaptureAspect

type RecordingMethod = Literal["hlae", "startmovie"]

# 播放进度条、观战资料和提示均为独立面板。保留准星、生命值／护甲、弹药和击杀提示。
_HIDDEN_HUD_PANELS = (
    "HudDemoController",
    "HudTeamCounter",
    "jsHudSpecplayer__Bg",
    "HudSpecplayer__Avatar",
    "JsHudLegendPanel",
    "HudSpectatorVignetting",
    "trueview_row",
    "HudTopLeft",
    "HudLowerLeft",
    "HudChat",
    "HudWeaponSelection",
)
_CLEAN_HUD = "; ".join(
    (
        "cl_draw_only_deathnotices 0",
        "cl_spec_show_bindings 0",
        "cl_trueview_show_status 0",
        "r_show_build_info 0",
        "cl_showpos 0",
        "cl_showfps 0",
        "cl_drawhud_force_teamid_overhead -1",
        *(f"mirv_panorama panelStyle panelId={name} opacity=0" for name in _HIDDEN_HUD_PANELS),
        "mirv_panorama panelStyle panelClassName=HudPerfStatsBasics opacity=0",
    )
)


def _console_path(path: Path) -> str:
    value = path.as_posix()
    if not value.isascii() or any(ord(char) < 32 or char in '";' for char in value):
        raise ValueError("CS2 录制临时目录需要使用不含引号和分号的 ASCII 路径。")
    return f'"{value}"'


def hlae_argv(hlae: Path, cs2: Path, profile: Path, *, aspect: CaptureAspect = "16:9") -> list[str]:
    width, height = CAPTURE_SIZES[aspect]
    game_arguments = subprocess.list2cmdline(
        [
            "-steam",
            "-insecure",
            "+sv_lan",
            "1",
            "-afxDisableSteamStorage",
            "-console",
            "-sw",
            "-w",
            str(width),
            "-h",
            str(height),
            "+exec",
            "workbench_p2",
        ]
    )
    return [
        str(hlae),
        "-noConfig",
        "-customLoader",
        "-autoStart",
        "-noGui",
        "-hookDllPath",
        str(hlae.parent / "x64" / "AfxHookSource2.dll"),
        "-programPath",
        str(cs2),
        "-cmdLine",
        game_arguments,
        "-addEnv",
        f"USRLOCALCSGO={profile}",
    ]


def write_capture_config(
    profile: Path,
    demo: Path,
    capture: Path,
    player_id: str,
    start_tick: int,
    end_tick: int,
    *,
    method: RecordingMethod,
    native_prefix: str,
) -> None:
    if re.fullmatch(r"[0-9]{17}", player_id) is None:
        raise ValueError("玩家 SteamID64 无效。")
    if re.fullmatch(r"[a-z0-9_]+", native_prefix) is None:
        raise ValueError("原生录制临时名称无效。")
    if method == "hlae":
        setup = (
            "mirv_streams record screen enabled 1; mirv_streams record screen settings afxClassic; "
            "mirv_streams record fps 60; mirv_streams record startMovieWav 1; "
            f"mirv_streams record name {_console_path(capture)}"
        )
        begin, end = "mirv_streams record start", "mirv_streams record end"
    else:
        setup = "host_framerate 60"
        begin, end = f"startmovie {native_prefix}", "endmovie; host_framerate 0"

    values = {
        "steamid": player_id,
        "start": start_tick,
        "end": end_tick,
        "seek": max(0, start_tick - 128),
        "hud": _CLEAN_HUD,
        "setup": setup,
        "begin": begin,
        "stop": end,
    }
    cfg = profile / "cfg"
    cfg.mkdir(parents=True, exist_ok=True)
    script = cfg / "workbench_p2.js"
    script.write_text(
        f"const options = {json.dumps(values)};\n" + _CAPTURE_SCRIPT, encoding="ascii"
    )
    (cfg / "workbench_p2.cfg").write_text(
        'mirv_script_load "mirv_script_spec_lock.js"\n'
        f"mirv_script_load {_console_path(script)}\n"
        "demo_ui_mode 0\n"
        f"playdemo {_console_path(demo)}\n",
        encoding="ascii",
    )


# HLAE 每帧的 demo tick 驱动 seek、选手锁定和录制，避免用墙钟时间猜测回放位置。
_CAPTURE_SCRIPT = """
const wanted = BigInt(options.steamid);
let phase = "load";
let selectedAt = -1;
let quitAfter = 0;

function targetIndex() {
    for (let index = 1; index <= 64; ++index) {
        const entity = mirv.getEntityFromIndex(index);
        if (entity && entity.isPlayerController() && entity.getSteamId() === wanted) return index;
    }
    return 0;
}

function leave() {
    phase = "done";
    mirv.exec("quit");
}

mirv.events.clientFrameStageNotify.on("workbench-p2", (event) => {
    if (event.isBefore || phase === "done") return;
    if (phase === "flush") {
        if (Date.now() >= quitAfter) leave();
        return;
    }
    if (!mirv.isPlayingDemo()) {
        if (phase === "record") {
            phase = "flush";
            quitAfter = Date.now() + 1000;
            mirv.exec(options.stop);
        }
        return;
    }
    const tick = mirv.getDemoTick();
    if (typeof tick !== "number" || tick < 0) return;
    if (phase === "load") {
        if (tick < Math.min(96, Math.max(0, options.start - 2))) return;
        phase = "seek";
        if (tick + 1 < options.seek) {
            mirv.exec(`demo_gototick ${options.seek}`);
            return;
        }
    }
    if (phase === "seek") {
        if (tick < options.seek) return;
        const index = targetIndex();
        if (!index || tick >= options.start) {
            if (tick >= options.start) leave();
            return;
        }
        mirv.exec("sv_cheats 1; hideconsole; volume 1; cl_demo_freecam 0; " +
            "spec_mode 1; spec_show_xray 0; cl_demo_predict 1");
        mirv.exec(`spec_player ${index}; mirv_script_spec_lock ${index}`);
        mirv.exec(options.hud);
        mirv.exec(options.setup);
        if (mirv.isDemoPaused()) mirv.exec("demo_resume");
        selectedAt = tick;
        phase = "armed";
        return;
    }
    if (phase === "armed" && tick > selectedAt && tick >= options.start) {
        if (tick > options.start + 2 || tick >= options.end) { leave(); return; }
        phase = "record";
        mirv.exec(options.hud);
        mirv.exec(options.begin);
    }
    if (phase === "record" && tick >= options.end) {
        phase = "flush";
        quitAfter = Date.now() + 1000;
        mirv.exec(options.stop);
    }
});
"""
