# AI A3 新建操作与确认卡片验收

日期：2026-11-16。范围为 A3：`reminders_create`、`calendar_create_event`、`memos_create` 三个新建操作，可编辑确认卡片，共享日程与提醒字段，转到综合工作台手动表单，以及保存后的本地跳转。AI 只生成草稿，确认或手动表单保存后才经综合工作台 `api.ts` 写入。

本阶段没有登记读取、查询、修改或删除操作，没有对话持久化，也没有新增数据库迁移。卡片和转到表单后的未保存草稿仅保留在当前进程内。

## 当前验证状态

| 检查                                                                          | 当前结果                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm lint`                                                                   | 通过                                                                                             |
| `pnpm typecheck`                                                              | 通过                                                                                             |
| `pnpm test`                                                                   | 通过，40 个文件、380 项测试                                                                      |
| `pnpm exec prettier . --check`                                                | 通过                                                                                             |
| `pnpm --filter desktop build`                                                 | 通过；AI 对话页仍独立懒加载                                                                      |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`         | 通过                                                                                             |
| `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 通过，25 项测试                                                                                  |
| [PR #29 CI](https://github.com/roycelee597/WorkBench/pull/29/checks)          | 全绿                                                                                             |
| 隔离实例界面、逐句实测和截图                                                  | 通过；五句、编辑保存、取消、本地失败重试、取档、过去时间、转表单、多卡独立均已实测，已有深浅截图 |
| 隔离凭据及 dev / 模拟服务清理                                                 | 通过；精确隔离凭据目标查询为 NONE，本轮进程已停止，1420 / 18928 无监听                           |

自动测试使用 MockLlmClient、假写入端口与内存 SQLite，覆盖三个新建操作的严格参数、日期和重复转换、提前提醒取档、来源标记、确认前零业务写入、编辑后保存、取消、双击防重、失败后本地重试、多卡独立、纯文本、表单转移和结果跳转。共享字段另有编辑、只读、唯一 id、默认焦点及原编辑器回归；提醒和日程编辑器隐藏后 Portal 消失，返回后保留未保存草稿。

本轮已使用独立 identifier、目录和标题启动 dev 与本机模拟服务并完成界面验收。综合工作台日期为 11 月 16 日星期一，初始三个业务列表均为 0 条；后续所有业务记录均来自本轮合成操作。

## 隔离实例与双终端启动

所有命令在仓库根目录的 PowerShell 执行。仅使用以下独立配置和合成数据，不操作正式版窗口、数据库或凭据。

| 项目                         | 本轮配置                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| Tauri 配置                   | `dist/ai-a3-check/tauri.json`                                   |
| identifier                   | `com.royce.workbench.ai-a3-check`                               |
| `app.appDirectoriesOverride` | 仓库内的 `dist/ai-a3-check/app`，配置文件写入其解析后的绝对路径 |
| 窗口                         | “WorkBench AI A3 验收（隔离）”，1300 × 980                      |
| 模拟服务                     | `http://127.0.0.1:18928`                                        |
| 隔离凭据服务 / 账户          | `com.royce.workbench.ai-a3-check.ai` / `deepseek`               |
| 虚构凭据                     | `sk-fake-workbench-test-ab12`，只用于本机模拟服务               |
| 建议快速新建 / AI 快捷键     | `Ctrl+Alt+F10` / `Ctrl+Alt+F11`，以设置中显示的“当前生效”为准   |

终端一准备场景并启动模拟服务：

```powershell
$aiA3Root = Join-Path (Get-Location) 'dist/ai-a3-check'
New-Item -ItemType Directory -Path $aiA3Root -Force | Out-Null
'{"status":200,"scripted":true,"create_actions":true}' |
  Set-Content (Join-Path $aiA3Root 'scenario.json') -Encoding utf8
node apps/desktop/tests/ai-mock-server.mjs dist/ai-a3-check 18928
```

终端二准备独立配置并启动桌面端。此命令不清空已有隔离数据；复测时记录本轮开始前的业务记录数，不把已有合成记录算作本次写入。不要将 identifier 或目录替换为正式版值。

```powershell
$aiA3Root = Join-Path (Get-Location) 'dist/ai-a3-check'
$aiA3App = (New-Item -ItemType Directory -Path (Join-Path $aiA3Root 'app') -Force).FullName
@{
  identifier = 'com.royce.workbench.ai-a3-check'
  app = @{
    appDirectoriesOverride = $aiA3App
    windows = @(@{
      label = 'main'
      title = 'WorkBench AI A3 验收（隔离）'
      width = 1300
      height = 980
      minWidth = 900
      minHeight = 600
    })
  }
} | ConvertTo-Json -Depth 8 |
  Set-Content (Join-Path $aiA3Root 'tauri.json') -Encoding utf8
$env:WORKBENCH_AI_BASE_URL = 'http://127.0.0.1:18928'
pnpm --filter desktop tauri dev --config ../../dist/ai-a3-check/tauri.json
```

两个进程须处于同一宿主网络环境。地址覆盖仅用于 debug 编译；不会访问真实 DeepSeek 服务，也不需要放宽 CSP。应用已有本轮隔离配置且正在运行时，不重复启动第二个 dev 进程。

## 五句预设验收

模拟服务按 `apps/desktop/tests/ai-create-fixtures.mjs` 返回预设 `tool_calls`。夹具以请求发生时的 **Asia/Shanghai 自然日**计算“明天”“下周三”和下一个工作日，不把 2026-11-16 固定写成永远的“今天”。桌面验收机的本地时区应为 Asia/Shanghai；换日后以当次日期重新核对。

| 输入句子                                       | 预期草稿与保存结果                                                                                 | 本轮界面实测                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 明天下午三点提醒我交实验报告                   | 新建提醒“交实验报告”，明天 15:00，不重复                                                           | 通过；草稿为 2026-11-17 周二 15:00，编辑为 16:00 后确认保存并成功查看            |
| 每个工作日早上 8 点提醒我背单词                | 新建提醒“背单词”，下一个工作日 08:00，工作日重复，RRULE 表达周一至周五                             | 通过；2026-11-17 周二 08:00，确认后 RRULE 为工作日，来源为 AI                    |
| 下周三下午三点到四点和导师开会，提前半小时提醒 | 新建日程“和导师开会”，下一个自然周周三 15:00–16:00，提前 30 分钟；确认后生成关联提醒               | 通过；2026-11-25 周三 15:00–16:00，提前 30 分钟，保存与查看正确                  |
| 每周二四晚上七点打羽毛球，持续到 12 月底       | 新建日程“打羽毛球”，下一个周二或周四 19:00–20:00，每周二、四，结束日期为当年 12 月 31 日（含当天） | 通过；19:00–20:00，每周二、四，RRULE 截止北京时间 2026-12-31 当天结束            |
| 记一下：实验室门禁找张老师                     | 新建备忘录，标题“实验室门禁”，正文“实验室门禁找张老师”                                             | 通过；取消不写入，再次生成后实际保存失败、本地重试成功，最终仅一条备忘录且可查看 |

该模拟只验证既定 `tool_calls` 进入真实客户端、编排器、卡片和本地保存的流程，不证明真实模型能正确理解上述中文句子。真实模型理解、正确率和费用留到 A5，在用户自行填写真实 key 后另行验收。

## 界面操作步骤

1. 核对隔离窗口标题。进入设置，将快速新建和 AI 快捷键分别改为 `Ctrl+Alt+F10`、`Ctrl+Alt+F11`，确认注册成功；若已有其他应用占用，选择不同组合。只在本轮隔离实例填写虚构凭据，保存后密码框应清空，界面只显示尾号 `ab12`。
2. 切到 AI 助手，依次发送上表五句，每次等卡片出现后再继续。检查类型、标题、备注、日期和星期、时间、重复中文说明、提前提醒、优先级或标签。不能把 RRULE 原文当作卡片的重复说明。
3. 每张卡片出现后先不点确认。比较隔离库中日程、提醒和备忘录的记录数，**本轮业务写入增量应为 0**；设置和用量的正常写入不属于这三类业务写入。编辑卡片字段、切换工作台、回到 AI，仍不能产生业务记录。
4. 在其中一张提醒或日程卡片修改标题和时间，再点“确认”。应显示“正在保存…”到“已保存”；保存的是改后的值。快速连点确认只写一次由自动测试覆盖，本轮未另做手动双击；“查看”跳到综合工作台对应页面并定位。带提前提醒的日程还应有一条关联提醒；首次创建带时间项目时沿用现有开机自启提示，验收可选择“暂不”。
5. 对另一张卡片点“取消”，状态变为“已取消”，再次检查业务记录数没有增加。重新发送同一句可获得新的独立草稿；这次发送会增加一次模型调用，取消本身不会。
6. 对一张尚未确认的卡片点“在表单中打开”。应进入综合工作台相应页面并打开共享字段表单，卡片标为“已转到表单”。打开或关闭该表单都不写入；编辑后点表单“保存”才写入。原卡片不能再次确认。表单未保存时按 AI 快捷键，弹窗应隐藏；返回综合工作台后草稿仍在。原日程和提醒编辑器也应遵守同样的隐藏与恢复行为。
7. 使用下表三个补充标记检查黄色提示、多卡独立和取消。检查浅色、深色下控件和状态文字清晰；本轮界面使用普通合成文本；HTML/脚本不执行、Markdown 链接不渲染和错误文案的纯文本显示由自动测试覆盖，不将这些断言记为手动注入实测。
8. 检查本地保存失败后的“重试保存”：草稿保留，失败时不自动重试；点击“重试保存”只重试本地写入，不增加聊天 POST。自动测试以假 `execute` 抛错覆盖；本轮 GUI 另用隔离数据库的 `BEGIN IMMEDIATE` 事务持锁 45 秒（不修改数据）观察到实际保存失败，失败后 memos 仍为 0、聊天 POST 仍为 6。锁自动释放后点击“重试保存”成功，仅新增一条备忘录，POST 仍为 6，已实测本地重试不调用模型。模拟 HTTP 503 只能验证模型调用失败，不能代替本地写入失败验收，不通过破坏隔离库或修改系统权限制造故障。

需要复现本地保存失败时，先生成一张尚未确认的卡片，再在第三个终端运行以下命令；看到“隔离写锁已持有”后，在 45 秒内点卡片“确认”。失败后等待终端显示“隔离写锁已释放”，再点“重试保存”。这里只持锁并回滚，不修改业务数据，不需要额外安装 SQLite 工具。

```powershell
@'
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
const testFile = path.resolve("dist/ai-a3-check/app/workbench.db");
if (!fs.existsSync(testFile)) throw new Error("请先启动隔离实例");
const testDb = new DatabaseSync(testFile);
testDb.exec("BEGIN IMMEDIATE");
console.log("隔离写锁已持有，请在卡片中点确认");
setTimeout(() => {
  testDb.exec("ROLLBACK");
  testDb.close();
  console.log("隔离写锁已释放，可以重试保存");
}, 45_000);
'@ | node --input-type=module
```

| 补充输入      | 预期                                                                             | 本轮界面实测                                                   |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `A3:rounding` | 明天 15:00 的日程，20 分钟提前提醒向下取为 15 分钟，黄色说明取档，可继续手动修改 | 通过；第 7 次 POST，黄色提示和选中 15 分钟可见，取消后未写入   |
| `A3:past`     | 昨天 15:00 的提醒，黄色提示时间已在过去，仍须确认才保存                          | 通过；2026-11-15 周日 15:00 与黄提示，转表单并关闭后未写入     |
| `A3:multiple` | 一次回复含提醒和备忘录两张卡片，可以分别编辑、确认或取消，状态互不影响           | 通过；第 9 次 POST，取消备忘录、仅确认提醒，最终仅增加一条提醒 |

## 本地证据核对

模拟服务只记录字段名、角色、工具名、状态和调用参数等非敏感元数据到 `dist/ai-a3-check/requests.jsonl`，不记录正文或 Authorization。本轮共 9 次聊天 POST，每次 `tool_names` 均恰为以下三个写入工具：

```text
reminders_create
calendar_create_event
memos_create
```

已核对这 9 次请求没有读取、修改或删除工具；新建不使用 ref。每次预设回复含写入调用，应在该轮停止，不再调用模型。确认、取消、编辑、转表单、结果跳转和本地重试均不应增加 `/chat/completions` 的 POST 数。可在发送前后及本地动作前后运行：

```powershell
$aiA3RequestLog = Join-Path (Get-Location) 'dist/ai-a3-check/requests.jsonl'
if (Test-Path -LiteralPath $aiA3RequestLog) {
  $aiA3Requests = Get-Content -LiteralPath $aiA3RequestLog | ConvertFrom-Json
  @($aiA3Requests | Where-Object {
    $_.method -eq 'POST' -and $_.path -eq '/chat/completions'
  }).Count
  $aiA3Requests | Where-Object { $_.path -eq '/chat/completions' } |
    Select-Object time, tool_names, status
}
```

仅检查隔离数据库 `dist/ai-a3-check/app/workbench.db`。以下 Node 24 内置 SQLite 命令以只读方式输出业务数量和合成字段，不创建或修改记录。若文件尚未生成，先完成隔离启动；不要把路径改成正式版目录。

```powershell
@'
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const db = new DatabaseSync(path.resolve("dist/ai-a3-check/app/workbench.db"), { readOnly: true });
try {
  for (const table of ["events", "reminders", "memos"]) {
    console.log(table, db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE deleted_at IS NULL AND purged_at IS NULL`).get());
  }
  console.table(db.prepare("SELECT title, start_at, end_at, timezone, rrule, remind_before_minutes, source_workbench FROM events WHERE deleted_at IS NULL AND purged_at IS NULL").all());
  console.table(db.prepare("SELECT title, due_at, timezone, rrule, source, source_workbench, event_id IS NOT NULL AS linked_event FROM reminders WHERE deleted_at IS NULL AND purged_at IS NULL").all());
  console.table(db.prepare("SELECT title, content, tags, pinned FROM memos WHERE deleted_at IS NULL AND purged_at IS NULL").all());
} finally {
  db.close();
}
'@ | node --input-type=module
```

应核对：

- AI 直接新建的日程、提醒，其 `source_workbench` 为 `com.royce.workbench.ai`；直接新建提醒的 `source` 仍为 `manual`。日程生成的关联提醒使用现有 `source='event'` 和关联关系。备忘录表不新增来源字段。
- 工作日提醒展开为周一至周五，周二、四日程展开为对应两天；`UNTIL` 按日程时区覆盖 12 月 31 日结束。RRULE 字段顺序可以不同，应比较解析后的含义；数据库中的 UTC 结束值不必字面等于当地日期。
- 默认一小时的结束时间、全天日程的含当天表单显示与不含结束日的存储边界、提前提醒和标签规范化已有自动测试；需要手动补充时仍只在隔离实例使用合成内容。
- 保存后的本地跳转只读取本地记录以定位页面，不把这些记录登记成模型的读取能力。新建草稿、真实 id、本地错误原因不进入后续模型历史；原始用户输入本身仍会随本次聊天请求发送。

已完成第一句的隔离库核对：生成提醒草稿后，备忘录、日程、提醒数量仍为 0 / 0 / 0；把标题改为“交实验报告（已核对）”、到期时间改为 2026-11-17 16:00 并确认后，仅新增一条提醒。其 `due_at=1794902400000`，`source='manual'`，`source_workbench='com.royce.workbench.ai'`。随后已核对工作日提醒、导师日程和周二四日程的保存。五句保存及本地重试阶段，隔离库累计 2 条日程、3 条提醒（其中 1 条由日程关联生成）、1 条备忘录。备忘录第一次取消后数量仍为 0；重新发送后的第二张卡片实际保存失败，数量仍为 0。锁释放后本地重试成功，仅生成标题“实验室门禁”、正文“实验室门禁找张老师”、空标签的一条备忘录。失败及重试前后聊天 POST 均为 6；随后取档和过去时间预设各新增一次请求，累计为 8；多卡片预设再新增一次，最终为 9。过去时间卡片转到手动表单、编辑、切换和取消后，数量仍为 1 条备忘录 / 2 条日程 / 3 条提醒；多卡片中取消备忘录并仅确认提醒后，最终为 1 / 2 / 4。四条提醒包含 3 条 manual、1 条 event，来源均为 AI。Rust 持久化用量文件记录 9 次调用、输入 108 / 输出 36 token；保存重试、查看和手动转交没有增加 POST。

## 已观察到的界面结果

- 快速新建 `Ctrl+Alt+F10`、AI `Ctrl+Alt+F11` 均已保存并生效；虚构凭据保存后可以正常发送聊天请求。
- 第一句先生成 2026-11-17 周二 15:00 的提醒卡片。修改标题和到期时间后，确认保存的是改后的内容；首次带时间提醒沿用开机自启提示，已选择“暂不”。
- 保存后字段禁用，卡片仅保留“查看”按钮；点击后打开综合工作台提醒详情，显示“交实验报告（已核对）”和 16:00。
- 在该提醒详情直接按 AI 快捷键，原 Portal 弹窗隐藏，AI 页面恢复，对话仍保留。
- 工作日提醒卡显示 2026-11-17 周二 08:00 和“工作日（周一至五）”；确认后 RRULE 为 `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`，来源为 AI。
- 导师日程卡显示 2026-11-25 周三 15:00–16:00、提前 30 分钟；保存的日程来源为 AI，关联提醒 `source='event'`、来源同为 AI，到期时间比日程开始早 1800000 ms。“查看”打开综合工作台日历编辑详情，日期和时间正确；从详情按 AI 快捷键后旧 Portal 消失。
- 周二、四羽毛球日程显示 19:00–20:00，结束重复日期为 2026-12-31；保存的 RRULE 为 `FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T155959Z`，按北京时间覆盖 12 月 31 日当天。

- 浅色备忘录卡片显示标题“实验室门禁”、正文“实验室门禁找张老师”、空标签和未置顶。点击“取消”后状态为“已取消”，隔离库备忘录仍为 0。
- 再次发送同一句得到第二张备忘录卡片。通过隔离库持锁且不修改数据的方式，点击确认后实际经历“正在保存”到“保存失败 / 保存未完成，请重试。”；备忘录仍为 0、聊天 POST 仍为 6。锁自动释放后点击“重试保存”成功，仅新增一条备忘录，POST 仍为 6；点击“查看”成功定位到综合工作台的该条备忘录。

- `A3:rounding` 是第 7 次聊天 POST：黄色提示将 20 分钟调整为 15 分钟，提前提醒下拉选中 15 分钟；已取消，未写入日程。
- `A3:past` 是第 8 次聊天 POST：卡片显示 2026-11-15 周日 15:00，并有“时间已在过去，请确认日期和时间是否正确。”黄色提示。此卡随后用于转到手动表单，未确认写入；手动表单操作见下。

- 在过去时间提醒卡片编辑备注后，点击“在表单中打开”，综合工作台手动 Dialog 显示“草稿尚未保存”和改后的备注；隔离库仍为 1 / 2 / 3。表单内把备注改为“手动表单中的修改，切换工作台后应保留”，按 AI 快捷键返回后卡片显示“已转到表单”，没有确认按钮。回到综合工作台，备注仍在；点击“取消”关闭表单后，数量仍为 1 / 2 / 3。
- 第 9 次 POST 的 `A3:multiple` 产生提醒和备忘录两张卡片。取消备忘录后仅确认提醒，最终隔离库为 1 条备忘录、2 条日程、4 条提醒，没有写入多卡片中的备忘录。两卡的取消和保存状态互不影响。

- 最终请求统计为 9 次聊天 POST，每次仅有三个 create 工具；用量为 9 次调用、输入 108 / 输出 36 token。只读核对隔离库最终为 1 条备忘录、2 条日程、4 条提醒，`PRAGMA quick_check` 返回 `ok`。扫描隔离 app 文件（包括数据库/WAL、用量、日志）与 `requests.jsonl`，未发现虚构凭据的 UTF-8 或 UTF-16 文本。

## 界面截图

以下截图已按实际观察核对并确认文件存在。编辑保存过程使用深色截图，取档、取消、重试和手动表单等使用浅色截图；不为同一观察另建未采集的占位链接。截图中不显示完整凭据或任何真实数据。

| 截图                                                                  | 内容                                                 | 当前状态 |
| --------------------------------------------------------------------- | ---------------------------------------------------- | -------- |
| [提醒草稿（深色）](screenshots/ai-a3-reminder-dark.jpg)               | 明天 15:00 的提醒卡片，深色                          | 已采集   |
| [编辑提醒（深色）](screenshots/ai-a3-reminder-edited-dark.jpg)        | 修改后的标题和 16:00 到期时间                        | 已采集   |
| [提醒已保存（深色）](screenshots/ai-a3-reminder-saved-dark.jpg)       | 字段禁用与“查看”按钮                                 | 已采集   |
| [查看提醒（深色）](screenshots/ai-a3-reminder-view-dark.jpg)          | 综合工作台提醒详情显示改后的内容                     | 已采集   |
| [工作日提醒（深色）](screenshots/ai-a3-workdays-dark.jpg)             | 2026-11-17 08:00 与工作日中文规则                    | 已采集   |
| [导师日程（深色）](screenshots/ai-a3-event-dark.jpg)                  | 下周三日期星期和提前 30 分钟                         | 已采集   |
| [查看导师日程（深色）](screenshots/ai-a3-event-view-dark.jpg)         | 综合工作台日历编辑详情                               | 已采集   |
| [周二四重复字段（深色）](screenshots/ai-a3-weekly-dark.jpg)           | 重复星期、截止日期等底部字段                         | 已采集   |
| [周二四日期摘要（深色）](screenshots/ai-a3-weekly-summary-dark.jpg)   | 标题、时间与中文重复摘要                             | 已采集   |
| [备忘录草稿（浅色）](screenshots/ai-a3-memo-light.jpg)                | 纯文本标题、正文、空标签和未置顶                     | 已采集   |
| [备忘录已取消（浅色）](screenshots/ai-a3-cancelled-light.jpg)         | 取消后状态，未写入备忘录                             | 已采集   |
| [备忘录保存失败（浅色）](screenshots/ai-a3-save-failed-light.jpg)     | 隔离库持锁引发的真实本地保存失败                     | 已采集   |
| [备忘录重试成功（浅色）](screenshots/ai-a3-save-retried-light.jpg)    | 锁释放后仅本地重试，成功保存一条                     | 已采集   |
| [查看备忘录（浅色）](screenshots/ai-a3-memo-view-light.jpg)           | 综合工作台备忘录页定位到该条                         | 已采集   |
| [提前提醒取档（浅色）](screenshots/ai-a3-rounding-light.jpg)          | 20→15 分钟黄色提示及选中值                           | 已采集   |
| [过去时间提示（浅色）](screenshots/ai-a3-past-light.jpg)              | 2026-11-15 周日 15:00 与黄色提示                     | 已采集   |
| [转到手动表单（浅色）](screenshots/ai-a3-manual-form-light.jpg)       | 草稿尚未保存，带入卡片编辑后的备注                   | 已采集   |
| [已转到表单（浅色）](screenshots/ai-a3-transferred-light.jpg)         | AI 卡片标记已转交，没有确认按钮                      | 已采集   |
| [手动草稿保留（浅色）](screenshots/ai-a3-manual-retained-light.jpg)   | 切回综合工作台后保留表单内修改的备注                 | 已采集   |
| [多卡片分别取消（浅色）](screenshots/ai-a3-multiple-cancel-light.jpg) | 取消备忘录，提醒卡仍可确认                           | 已采集   |
| [多卡片分别保存（浅色）](screenshots/ai-a3-multiple-saved-light.jpg)  | 仅提醒保存，备忘录仍为已取消                         | 已采集   |
| [清理后无 key（浅色）](screenshots/ai-a3-cleanup-no-key-light.jpg)    | 移除隔离虚构凭据后重新进入 AI，无 key 引导且发送禁用 | 已采集   |

## 实测与清理结果

| 项目                                 | 当前结果                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| 隔离配置、独立窗口和实际 dev 启动    | 通过；重启后独立窗口已成功前置并读取界面，18928 模拟服务已启动                       |
| 五句卡片、确认前零写入、确认后结果   | 通过；五句草稿及保存、第一句确认前 0 写入、取消/转表单不写入和重试后仅一条均已核对   |
| 编辑后保存、取消和多卡独立           | 通过；提醒按编辑后值保存，取消不写入，多卡取消备忘录后仅新增提醒                     |
| 转到表单、切换时保留草稿、关闭不写入 | 通过；带入卡片备注，转交状态无确认按钮，切换后保留手动修改，取消关闭后数量不变       |
| 保存失败后本地重试不调用模型         | 通过；实际保存失败时 memos 为 0，重试成功后仅 1 条，失败与重试前后 POST 均为 6       |
| 结果跳转、来源、RRULE 与关联提醒     | 三类查看跳转、日程/提醒 AI 来源、两类重复 RRULE、提前 30 分钟关联提醒通过            |
| 浅色、深色截图                       | 已采集九张深色、十三张浅色截图，共 22 张，见截图索引                                 |
| 隔离凭据清理                         | 通过；精确隔离目标查询 NONE，重新挂载 AI 后显示无 key 引导且发送禁用                 |
| dev、模拟服务与端口清理              | 通过；精确停止本轮 Native / Vite / mock，remaining_test_pids=[]，1420 / 18928 无监听 |

本轮已仅删除精确的虚构凭据目标 `deepseek.com.royce.workbench.ai-a3-check.ai`，`cmdkey` 指定查询结果为 `NONE`。切到综合工作台再返回 AI，重新挂载后显示无 key 引导，发送按钮禁用；未读取凭据密码。

依据核验后的 PID 路径与命令，已精确停止本轮 Native、Vite 和 mock 进程，`remaining_test_pids=[]`，1420 / 18928 无监听；用于故障注入的 SQLite 45 秒持锁进程已自然释放并退出。隔离数据库完整性检查为 `ok`，最终业务数量和用量与上文一致。

本轮仅访问 `dist/ai-a3-check` 隔离目录和相应虚构凭据，不访问正式版数据与凭据。配置、数据库、用量和请求日志留在 Git 忽略目录，只有代码、本文与已核对的脱敏截图进入提交。
