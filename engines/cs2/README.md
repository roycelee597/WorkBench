# CS2 demo 高光引擎

P1 读取本地 `.dem`，列出可选玩家，并为指定玩家计算高光和剪辑时间。P2 在 Windows 上尝试录制 P1 选出的一段第一人称画面。预览和录制边界都使用 demo 的 tick。

## 在 Windows 上预览一场对局

1. 解压 demo 的 ZIP。在仓库外新建一个测试目录，把 `.dem` 放进去并命名为 `match.dem`。
2. 在同一目录新建 UTF-8 编码的 `task.json`，填入下面的内容。

   ```json
   {
     "schema_version": 1,
     "mode": "inspect",
     "demo_path": "match.dem",
     "work_dir": "preview"
   }
   ```

3. 在仓库根目录运行下面的命令，把示例路径换成刚新建的 `task.json` 路径。

   ```powershell
   uv run --project engines/cs2 --locked cs2-engine run --task 'D:/DemoTest/task.json'
   ```

4. 打开测试目录里的 `preview/highlights.json`，从 `players` 里找到目标玩家并复制其 `steamid64`。在 `task.json` 的最外层加上 `"player": {"steamid64": "复制到的号码"}`，保留号码两侧的引号，然后重跑上面的命令。`highlights` 会列出该玩家的高光。想同时查看受害者视角的起止 tick，可加上 `"victim_pov": true`。
5. 可以在 `task.json` 最外层加上 `"rules": {"pre_s": 1, "post_s": 0.5}` 再运行一次，比较同一段的起止 tick。每个任务使用自己的 `work_dir`。真实 demo、玩家名单和输出 JSON 都留在本机。

## 修改判定规则

`highlights` 可填写 `multikill`（多杀）、`clutch`（残局）、`quick_kills`（连杀）、`special`（特殊击杀）、`knife`（刀杀）、`zeus`（电击枪）、`noscope`（不开镜）和 `onetap`（单发爆头）。省略时启用全部，填空数组时只列玩家。勾选项决定哪些事件生成片段。同一击杀匹配的其他标签会随片段返回。

在 `rules` 里只写要改的项目。时间均用秒。完整配置及默认值见 [rules.py](cs2_engine/rules.py)。

| 判定       | 配置与默认值                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 多杀       | `multikill_min_kills` 为 3，`ace_min_kills` 为 5                                                                                                                                                                                                 |
| 残局       | `clutch_min_enemies` 为 2，`clutch_include_losses` 为 `false`，`clutch_max_s` 为 30。超时保留残局期间的击杀窗口                                                                                                                                  |
| 短时间连杀 | `quick_kills_min_kills` 为 2，`quick_kills_window_s` 为 3                                                                                                                                                                                        |
| 特殊击杀   | `special_conditions` 为 `wallbang`、`airborne`、`blind`、`through_smoke`，分别对应穿墙、空中击杀、致盲和穿烟。`special_min_penetrations` 为 1，`knife_as_special`、`zeus_as_special` 均为 `true`                                                 |
| 武器类型   | `knife_weapons` 和 `knife_weapon_prefixes` 匹配刀，`zeus_weapons` 默认为 `taser`，`noscope_weapons` 默认为 `awp`、`ssg08`，`onetap_weapons` 默认为 `ak47`、`deagle`。单发爆头要求 `onetap_window_s`（默认 1 秒）内有且只有一次对应武器的开火事件 |
| 剪辑窗口   | `pre_s` 为 3，`post_s` 为 1.5。`merge_gap_s` 为 2，同回合的窗口重叠或间隔小于该值时合并                                                                                                                                                          |
| 受害者视角 | `victim_pre_s` 为 2，`victim_post_s` 为 0.5，窗口按击杀顺序列出                                                                                                                                                                                  |

## 输出协议

任务版本为 `1`，模式为 `inspect` 或 `record`。任务里的相对路径以 `task.json` 所在目录为基准。

标准输出每行一个 JSON 对象。`inspect` 的进度阶段为 `parse`、`score`，成功以 `result.inspect` 结束。`record` 的进度阶段为 `prepare`、`record`、`compose`，切换备用录制时输出 `log`，成功以 `done` 结束。两个模式成功时均返回退出码 `0`。

任务、demo、玩家和输出目录出错时分别返回 `INVALID_TASK`、`DEMO_PARSE_FAILED`、`PLAYER_NOT_FOUND`、`OUTPUT_WRITE_FAILED`。录制还会返回 `CS2_NOT_FOUND`、`HLAE_NOT_FOUND`、`RECORD_FAILED`、`FFMPEG_FAILED`、`GAMEINFO_FAILED` 或 `PERMISSION_DENIED`。终端中断返回 `CANCELLED`。其他异常返回 `INTERNAL_ERROR`，异常堆栈只写到标准错误。失败的最后一行是 `error`，退出状态为非零。

工作目录内的 `parsed.json` 保存归一化事件，`highlights.json` 对应 `result.inspect`。每段预览带回合号 `round`、类别 `types`、标签 `tags`、`start_tick`、`end_tick`、`duration_s` 和 `victim_povs`。受害者窗口包含 `steamid64`（机器人或无法识别时为 `null`）、`death_tick`、起止 tick 和时长。

## 在 Windows 上录制 P2 单段

1. 安装新版 HLAE，保留安装目录下的 `HLAE.exe`、`x64/AfxHookSource2.dll` 和随附的 `resources/AfxHookSource2/snippets/mirv_script_spec_lock.js`。引擎依赖这个官方脚本锁定第一人称。解压 FFmpeg Windows 构建，让 `ffmpeg.exe` 和 `ffprobe.exe` 保持在同一个 `bin` 目录。Steam 保持运行，先退出平时游玩的 CS2。[HLAE 官方发布](https://github.com/advancedfx/advancedfx/releases/latest) · [FFmpeg 官网列出的 Windows 构建](https://ffmpeg.org/download.html#build-windows)
2. 在本机解压 `.dem`，用 P1 为目标玩家生成 `highlights.json`，从 `highlights` 数组选择一个片段，记下序号。第一段的序号是 `1`。把下面的 `record-task.json` 示例放到本机测试目录，换成自己的路径、片段序号和目标玩家 SteamID64。真实 demo、名单、任务文件及成品留在本机。

   ```json
   {
     "schema_version": 1,
     "mode": "record",
     "demo_path": "match.dem",
     "highlights_path": "preview/highlights.json",
     "segment_index": 1,
     "player": { "steamid64": "00000000000000001" },
     "work_dir": "record-work",
     "output_dir": "output",
     "cs2_path": "D:/Games/Counter-Strike Global Offensive",
     "hlae_path": "C:/Tools/HLAE/HLAE.exe",
     "ffmpeg_path": "C:/Tools/FFmpeg/bin/ffmpeg.exe",
     "recording_method": "auto",
     "aspect": "16:9"
   }
   ```

3. 在仓库根目录运行命令，把示例任务文件路径换成本机路径。任务会以 `-insecure` 启动本地回放，并用 `USRLOCALCSGO` 和 `-afxDisableSteamStorage` 隔离游戏配置。源 demo 的路径可以包含中文和空格，录制时会使用临时英文副本。逐帧图像需要额外磁盘空间，编码后清理。[HLAE 的 CS2 启动说明](https://github.com/advancedfx/advancedfx/wiki/AfxHookSource2)

   ```powershell
   uv run --project engines/cs2 --locked cs2-engine run --task 'D:/DemoTest/record-task.json'
   ```

4. 成功后打开 `output` 里的 MP4，检查是否为目标玩家第一人称，并检查准星、血量、护甲、弹药、击杀提示和音画同步。确认顶部队伍头像栏可见，切换武器时右侧武器栏出现。底部回放控制条、左下角版本信息和观战选手卡应当隐藏。`done` 和 `record-work/segments.json` 保存录制比例、原始画面分辨率、录制方式、文件时长和大小、从启动 HLAE 到退出 CS2 的耗时，以及 `gameinfo.gi` 的校验结果。可在录制前后分别用 PowerShell 的 `Get-FileHash -Algorithm SHA256 -LiteralPath` 比较游戏安装目录 `game/csgo/gameinfo.gi` 的哈希。
5. 复验取消时，录制中按 `Ctrl+C`，检查 CS2 已退出、没有留下成品，并再次核对 `gameinfo.gi` 的哈希。P2 引擎本身不修改 `gameinfo.gi`。备份和启动时的 SHA-256、大小、修改时间用于防范 HLAE 或游戏意外改动。恢复时发现配置缺失或属于未知版本，会保留原备份和现有文件，并返回 `GAMEINFO_FAILED`。

   正常退出、失败或取消时，任务先结束受托管的进程，再处理恢复记录。引擎进程崩溃由独立看护进程接手。它和下方恢复命令都会清理本次 `startmovie` 在 `game/csgo`、`bin/win64` 和隔离配置目录里留下的 TGA/WAV。清理限于登记的 `wbp2_<32 位十六进制>` 前缀，并跳过链接。整机断电后，下一次录制会检查持久化恢复记录，也可以先执行以下命令。恢复记录放在 `%LOCALAPPDATA%/WorkBench-CS2-Prototype`。

   ```powershell
   uv run --project engines/cs2 --locked cs2-engine recover-gameinfo --cs2-path 'D:/Games/Counter-Strike Global Offensive'
   ```

   如果提示 `gameinfo.gi` 缺失或属于未知版本，先在 Steam 对 CS2 执行「验证游戏文件完整性」。验证完成后运行以下命令。它会结束原录制进程，清理本次的 TGA/WAV，保留当前 `gameinfo.gi`，并清除旧恢复记录和备份。随后即可重试录制。

   ```powershell
   uv run --project engines/cs2 --locked cs2-engine recover-gameinfo --cs2-path 'D:/Games/Counter-Strike Global Offensive' --accept-current
   ```

`aspect` 可选，默认为 `"16:9"`，CS2 以 1920×1080 渲染。`"4:3-stretched"` 让 CS2 以 1440×1080 渲染，FFmpeg 再横向拉伸至 1920×1080。两种模式均输出 60 fps 的 1080p MP4。录制时会校验原始帧尺寸，确保 CS2 实际按选定比例渲染。

CS2 回放继续使用 Valve 的第一人称观战画面。录制会自动使用 demo 中目标玩家的准星设置。片段起点的准星设置缺失或无法读取时，引擎会输出一条提示，并使用独立录制配置中的 CS2 默认准星。

录制时通过 HLAE 的 `mirv_panorama` 定向隐藏部分面板。CS2 更新可能重命名 HUD 面板，使对应的隐藏规则静默失效。每次 CS2 更新后，请试录一段包含武器切换的片段，并按第 4 步核对 HUD。[HLAE 面板控制文档](https://github.com/advancedfx/advancedfx/wiki/Source2%3Amirv_panorama)

`recording_method` 默认是 `auto`。先用 HLAE `mirv_streams` 输出 TGA 帧和 WAV，交给 FFmpeg 合成。原始捕获校验失败时会记录原因，并改用 CS2 的 `host_framerate`、`startmovie`、`endmovie` 捕获。备用方式仍用 HLAE 控制跳转、锁定视角、隐藏面板和隔离配置。可填写 `hlae` 或 `startmovie` 单独复验相应方式。两种方式都需要已能启动离线回放的 HLAE。[HLAE 逐帧录制文档](https://github.com/advancedfx/advancedfx/wiki/Source2%3Amirv_streams) · [CS2 Windows 回放控制说明](https://cs-demo-manager.com/docs/development/cs-server-plugin)

## 测试和打包

在仓库根目录运行以下命令。单元测试使用合成回合和事件。

```powershell
uv run --project engines/cs2 --locked pytest engines/cs2/tests
uv run --project engines/cs2 --locked --group build python engines/cs2/scripts/build_sidecar.py
```

Windows 可执行文件为 `engines/cs2/dist/cs2-engine.exe`，用它替换上述命令里的 `uv run --project engines/cs2 --locked cs2-engine` 即可运行同一任务。

demo 解析由 [demoparser2](https://github.com/LaihoE/demoparser) 提供，依赖版本记录在 `uv.lock`。
