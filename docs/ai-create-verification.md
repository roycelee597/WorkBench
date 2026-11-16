# AI A3 新建操作与确认卡片验收

日期：2026-11-16。范围为 A3：`reminders_create`、`calendar_create_event`、`memos_create` 三个新建操作，可编辑确认卡片，共享日程与提醒字段，转到综合工作台手动表单，以及保存后的本地跳转。AI 只生成草稿，确认或手动表单保存后才经综合工作台 `api.ts` 写入。

本阶段没有登记读取、查询、修改或删除操作，没有对话持久化，也没有新增数据库迁移。卡片和转到表单后的未保存草稿仅保留在当前进程内。

## 当前验证状态

| 检查                                                                          | 当前结果                         |
| ----------------------------------------------------------------------------- | -------------------------------- |
| `pnpm lint`                                                                   | 通过                             |
| `pnpm typecheck`                                                              | 通过                             |
| `pnpm test`                                                                   | 通过，40 个文件、380 项测试      |
| `pnpm exec prettier . --check`                                                | 通过                             |
| `pnpm --filter desktop build`                                                 | 通过；AI 对话页仍独立懒加载      |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`         | 通过                             |
| `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 通过，25 项测试                  |
| 隔离实例界面、逐句实测和截图                                                  | 待补，不能据自动测试标为手动通过 |
| 隔离凭据及 dev / 模拟服务清理                                                 | 待补                             |

自动测试使用 MockLlmClient、假写入端口与内存 SQLite，覆盖三个新建操作的严格参数、日期和重复转换、提前提醒取档、来源标记、确认前零业务写入、编辑后保存、取消、双击防重、失败后本地重试、多卡独立、纯文本、表单转移和结果跳转。共享字段另有编辑、只读、唯一 id、默认焦点及原编辑器回归；提醒和日程编辑器隐藏后 Portal 消失，返回后保留未保存草稿。

截至起草时，界面控制两次返回 `failed to activate captured window`，已请用户将标题为“WorkBench AI A3 验收（隔离）”的新隔离窗口放到前台。尚未观察到的界面步骤、截图和清理结果均在下文保留为“待补”。

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

| 输入句子                                       | 预期草稿与保存结果                                                                                 | 本轮界面实测 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------ |
| 明天下午三点提醒我交实验报告                   | 新建提醒“交实验报告”，明天 15:00，不重复                                                           | 待补         |
| 每个工作日早上 8 点提醒我背单词                | 新建提醒“背单词”，下一个工作日 08:00，工作日重复，RRULE 表达周一至周五                             | 待补         |
| 下周三下午三点到四点和导师开会，提前半小时提醒 | 新建日程“和导师开会”，下一个自然周周三 15:00–16:00，提前 30 分钟；确认后生成关联提醒               | 待补         |
| 每周二四晚上七点打羽毛球，持续到 12 月底       | 新建日程“打羽毛球”，下一个周二或周四 19:00–20:00，每周二、四，结束日期为当年 12 月 31 日（含当天） | 待补         |
| 记一下：实验室门禁找张老师                     | 新建备忘录，标题“实验室门禁”，正文“实验室门禁找张老师”                                             | 待补         |

该模拟只验证既定 `tool_calls` 进入真实客户端、编排器、卡片和本地保存的流程，不证明真实模型能正确理解上述中文句子。真实模型理解、正确率和费用留到 A5，在用户自行填写真实 key 后另行验收。

## 界面操作步骤

1. 核对隔离窗口标题。进入设置，将快速新建和 AI 快捷键分别改为 `Ctrl+Alt+F10`、`Ctrl+Alt+F11`，确认注册成功；若已有其他应用占用，选择不同组合。只在本轮隔离实例填写虚构凭据，保存后密码框应清空，界面只显示尾号 `ab12`。
2. 切到 AI 助手，依次发送上表五句，每次等卡片出现后再继续。检查类型、标题、备注、日期和星期、时间、重复中文说明、提前提醒、优先级或标签。不能把 RRULE 原文当作卡片的重复说明。
3. 每张卡片出现后先不点确认。比较隔离库中日程、提醒和备忘录的记录数，**本轮业务写入增量应为 0**；设置和用量的正常写入不属于这三类业务写入。编辑卡片字段、切换工作台、回到 AI，仍不能产生业务记录。
4. 在其中一张提醒或日程卡片修改标题和时间，再点“确认”。应显示“正在保存…”到“已保存”；保存的是改后的值。快速连点确认应只生成一份记录；“查看”跳到综合工作台对应页面并定位。带提前提醒的日程还应有一条关联提醒；首次创建带时间项目时沿用现有开机自启提示，验收可选择“暂不”。
5. 对另一张卡片点“取消”，状态变为“已取消”，再次检查业务记录数没有增加。重新发送同一句可获得新的独立草稿；这次发送会增加一次模型调用，取消本身不会。
6. 对一张尚未确认的卡片点“在表单中打开”。应进入综合工作台相应页面并打开共享字段表单，卡片标为“已转到表单”。打开或关闭该表单都不写入；编辑后点表单“保存”才写入。原卡片不能再次确认。表单未保存时按 AI 快捷键，弹窗应隐藏；返回综合工作台后草稿仍在。原日程和提醒编辑器也应遵守同样的隐藏与恢复行为。
7. 使用下表三个补充标记检查黄色提示、多卡独立和取消。检查浅色、深色下控件和状态文字清晰；标题、备注和备忘录内容只作为纯文本显示，不执行 HTML，也不渲染模型提供的 Markdown 链接。
8. 检查本地保存失败后的“重试保存”：草稿保留，失败时不自动重试；点击“重试保存”只重试本地写入，不增加聊天 POST。当前可控故障由自动测试的假 `execute` 抛错覆盖；GUI 实测故障和结果仍待补。模拟 HTTP 503 只能验证模型调用失败，不能代替本地写入失败验收，不通过破坏隔离库或修改系统权限制造故障。

| 补充输入      | 预期                                                                             | 本轮界面实测 |
| ------------- | -------------------------------------------------------------------------------- | ------------ |
| `A3:rounding` | 明天 15:00 的日程，20 分钟提前提醒向下取为 15 分钟，黄色说明取档，可继续手动修改 | 待补         |
| `A3:past`     | 昨天 15:00 的提醒，黄色提示时间已在过去，仍须确认才保存                          | 待补         |
| `A3:multiple` | 一次回复含提醒和备忘录两张卡片，可以分别编辑、确认或取消，状态互不影响           | 待补         |

## 本地证据核对

模拟服务只记录字段名、角色、工具名、状态和调用参数等非敏感元数据到 `dist/ai-a3-check/requests.jsonl`，不记录正文或 Authorization。检查聊天请求的 `tool_names` 应恰为以下三个写入工具：

```text
reminders_create
calendar_create_event
memos_create
```

不得出现读取、修改或删除工具；新建不使用 ref。每次预设回复含写入调用，应在该轮停止，不再调用模型。确认、取消、编辑、转表单、结果跳转和本地重试均不应增加 `/chat/completions` 的 POST 数。可在发送前后及本地动作前后运行：

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

本节数据库数量、RRULE、来源和请求统计的本轮 GUI 配套实测结果：**待补**。

## 截图计划索引

以下名称为计划，尚无实测截图，不创建图片链接；补齐文件并核对画面后再添加链接。截图中不显示完整凭据或任何真实数据。

| 计划名称                   | 内容                                     | 当前状态 |
| -------------------------- | ---------------------------------------- | -------- |
| `ai-a3-reminder-dark`      | 明天 15:00 的提醒卡片，深色              | 待补     |
| `ai-a3-workdays-dark`      | 工作日重复提醒及中文规则，深色           | 待补     |
| `ai-a3-event-dark`         | 下周三日程、日期星期和提前 30 分钟，深色 | 待补     |
| `ai-a3-weekly-dark`        | 周二、四重复日程及截止日期，深色         | 待补     |
| `ai-a3-memo-light`         | 备忘录纯文本编辑卡片，浅色               | 待补     |
| `ai-a3-edited-saved-light` | 编辑后保存与“查看”状态，浅色             | 待补     |
| `ai-a3-rounding-light`     | 20 分钟取档到 15 分钟的黄色提示，浅色    | 待补     |
| `ai-a3-manual-form-light`  | 转到共享手动表单且尚未保存，浅色         | 待补     |

## 实测与清理回填

| 项目                                 | 当前结果                                             |
| ------------------------------------ | ---------------------------------------------------- |
| 隔离配置、独立窗口和实际 dev 启动    | dev 已启动，独立标题已观察；界面操作仍受前置失败阻碍 |
| 五句卡片、确认前零写入、确认后结果   | 待补                                                 |
| 编辑后保存、取消和多卡独立           | 待补                                                 |
| 转到表单、切换时保留草稿、关闭不写入 | 待补                                                 |
| 保存失败后本地重试不调用模型         | 自动测试覆盖；GUI 实测待补                           |
| 结果跳转、来源、RRULE 与关联提醒     | 自动测试覆盖；GUI 及隔离库配套实测待补               |
| 浅色、深色截图                       | 待补                                                 |
| 隔离凭据清理                         | 待补                                                 |
| dev、模拟服务与端口清理              | 待补                                                 |

验收结束，在**隔离实例**设置中点击“清除”移除虚构凭据，并核对尚未设置。Windows 后端实际凭据目标为 `deepseek.com.royce.workbench.ai-a3-check.ai`，只核对该隔离目标的存在状态，不读取密码，也不操作正式版条目。

退出隔离应用，在两个终端分别按 `Ctrl+C` 停止 dev 和模拟服务，并核对本轮进程以及 1420 / 18928 监听已停止。清理是否完成须以实际观察回填；当前不声明已完成。隔离配置、数据库、用量和请求日志留在 Git 忽略的 `dist/ai-a3-check` 下，只有代码、本文及核对后的脱敏截图进入提交。
