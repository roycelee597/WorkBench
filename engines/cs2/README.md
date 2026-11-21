# CS2 demo 高光预览引擎

P1 读取本地 `.dem`，列出可选玩家，并为指定玩家计算高光和剪辑时间。预览使用 demo 的 tick。录制阶段的画面以正常游玩时的 HUD 为目标。

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

任务版本为 `1`，模式为 `inspect`。任务里的相对路径以 `task.json` 所在目录为基准。录制和输出画面的字段留待录制阶段消费。

标准输出每行一个 JSON 对象，通过 `type` 区分 `progress`、`result` 和 `error`。解析和评分进度分别用 `parse`、`score` 表示。成功以 `result.inspect` 和退出码 `0` 结束。任务、demo、玩家和输出目录出错时分别返回 `INVALID_TASK`、`DEMO_PARSE_FAILED`、`PLAYER_NOT_FOUND`、`OUTPUT_WRITE_FAILED`，并以非零状态退出。终端中断返回 `CANCELLED`。其他异常返回 `INTERNAL_ERROR`，异常堆栈只写到标准错误。

工作目录内的 `parsed.json` 保存归一化事件，`highlights.json` 对应 `result.inspect`。每段预览带回合号 `round`、类别 `types`、标签 `tags`、`start_tick`、`end_tick`、`duration_s` 和 `victim_povs`。受害者窗口包含 `steamid64`（机器人或无法识别时为 `null`）、`death_tick`、起止 tick 和时长。

## 测试和打包

在仓库根目录运行以下命令。单元测试使用合成回合和事件。

```powershell
uv run --project engines/cs2 --locked pytest engines/cs2/tests
uv run --project engines/cs2 --locked --group build python engines/cs2/scripts/build_sidecar.py
```

Windows 可执行文件为 `engines/cs2/dist/cs2-engine.exe`，用它替换上述命令里的 `uv run --project engines/cs2 --locked cs2-engine` 即可运行同一任务。

demo 解析由 [demoparser2](https://github.com/LaihoE/demoparser) 提供，依赖版本记录在 `uv.lock`。
