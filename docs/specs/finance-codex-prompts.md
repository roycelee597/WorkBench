# 金融指标工作台 Codex 提示词（F1–F5，按顺序，一次一个，上一个 PR 合并后再发下一个）

用法：

1. 在 Codex **新对话**里，先粘贴下面的「背景交接」，等 Codex 回复它对项目的理解摘要，确认没有理解错，再粘贴 F1。
2. 每个 PR 完成后，把 Codex 的报告和 PR 链接发给 WorkBench 审查。审查通过后由 Royce 合并（或让 Codex 执行 squash 合并），然后运行 `git checkout main && git pull`，再发下一个提示词。
3. 如果换了新对话，可以单独发某个 F 提示词：每个提示词开头都要求 Codex 先读本文件的「背景交接」和规格，所以单独粘贴也能用。

> 下面描述的现有代码情况，已于 2026-11-07 对照 GitHub 上 `roycelee597/WorkBench` 的 main 核对过（PR #12 合并后，`31583b1`）。

---

## 背景交接（新对话只需粘贴一次）

```
你好，接下来你要帮我开发 WorkBench 的新工作台。这是一个新对话，你没有之前的记忆，所以先请你了解项目背景。

【我是谁】我叫 Royce，是计算机专业的学生，编程基础比较弱，主要会用的语言是 Python，刚开始学用 GitHub。请全程用中文，每一步都说明你做了什么、为什么这样做、我应该怎么验证。需要我手动操作的地方（比如安装软件、登录、填 token），请停下来，把步骤一条一条写清楚。

【项目】WorkBench：模块化桌面工作台，开源（MIT），仓库 https://github.com/roycelee597/WorkBench，我电脑上的本地路径是 E:\RoyceLee597\project\WorkBench（Windows）。目标：一个主程序 + 多个“工作台”。内置“综合工作台”（备忘录 / 日程 / 提醒），以后通过插件加入更多工作台。数据保存在本地，表结构已经为以后多设备同步预留了字段。

【技术栈（不要更换）】Tauri 2 + React 19 + TypeScript（strict）+ Vite、Tailwind + shadcn/ui、Zustand、SQLite（tauri-plugin-sql）、Vitest、ESLint + Prettier。pnpm monorepo（pnpm 11.25.0，Node 24）：
- apps/desktop：主程序
  - src/core：db、repositories、scheduler、calendar
  - src/shell：AppShell 侧边栏、通知条、快速新建
  - src-tauri：Rust，只做系统能力（database.rs、desktop.rs、quick_create.rs）
- packages/sdk、packages/manifest：目前只是空入口，Phase 2 插件运行时还没做
- packages/ui：共享组件 Button、Dialog
- workbenches/general：综合工作台，所有数据调用集中在 src/api.ts
- docs/：规格和各功能的验证文档

【Phase 1 已完成（都已合并进 main）】
- 数据层：所有业务表都有 id（UUID v7）、created_at、updated_at、deleted_at、device_id、deletion_group_id、purged_at；只做软删除，永久清空也会保留墓碑。所有读写都走 apps/desktop/src/core/repositories。多条语句的事务通过 Rust 命令 execute_batch 执行，这个命令只允许 main 窗口调用。
- 迁移：src-tauri/migrations 里有 0001_init.sql 和 0002_reminder_scheduler.sql，在 src-tauri/src/lib.rs 里按版本号登记。改表只能新增迁移文件，不能修改已有的迁移。
- 备忘录（Tiptap，内容以 Markdown 存储）、日程（FullCalendar，支持 rrule 重复、仅此次 / 此后 / 全部三种修改范围、提前提醒自动生成 source='event' 的提醒）、回收站（30 天自动清理，保留墓碑）。
- 提醒事项 + 调度器：精确定时 + 30 秒轮询兜底；reminder_occurrences 表记录每一次提醒的状态；贪睡 10 分钟；启动时把错过的提醒合并成一条补发。
  通知只在软件内显示（右上角通知条，按钮是“完成”和“稍后 10 分钟”）。如果窗口隐藏在托盘，先唤起窗口再弹。不使用 Windows 系统通知，也不用 tauri-plugin-notification。
  注意：reminders.source 字段有 CHECK (source IN ('manual','event')) 约束，SQLite 改不了这个约束，所以新功能不要用新的 source 值。区分来源请用 source_workbench 字段。
- 今天页（今天的日程 + 今天和逾期的提醒 + 置顶备忘录，跨午夜自动刷新）；全局快捷键 Ctrl+Alt+N 呼出“快速新建”窗口。
- 托盘：关窗口 = 隐藏到托盘；托盘菜单有“打开 WorkBench / 新建提醒 / 退出”，双击打开。开机自启默认关闭，自启时带 --background 参数隐藏启动。单实例运行。
- 目前 AppShell 侧边栏只有“综合工作台”，设置页和回收站页挂在 workbenches/general 的 workspace-store 页面里。

【规矩】
- 动手前先读：README.md、AGENTS.md、ARCHITECTURE.md、CONTRIBUTING.md、docs/specs/general-workbench.md，以及这次的规格 docs/specs/finance-indicators.md 和提示词文件 docs/specs/finance-codex-prompts.md。规格是唯一依据，§16.1 是我已经确认的决定，不要改。§16.2 是你实现时要自己实测的技术点，实测结果写进文档。规格里没写清楚的地方，先问我，不要猜。
- 每个 PR：从最新 main 新建 feat/... 分支，只做这个 PR 的范围；小步提交，提交信息用 Conventional Commits（中文说明）。pnpm lint / typecheck / test 和 prettier --check 都要通过，Windows CI（.github/workflows/ci.yml，windows-latest）要保持全绿。新逻辑必须有单元测试。写一份 docs/ 下的验证文档（自动检查 + 我能照着做的手动步骤 + 实测记录）。用 gh 开 PR，按 PR 模板填写。最后向我报告：改了什么、验证结果、PR 链接、需要我手动做的事。
- 不要合并 PR（除非我明确让你合并），不要强制推送，不要改写已经推送的历史。不要提交密钥、.env、数据库文件或构建产物。
- Tushare token 是密钥：绝不能写进代码、文档、日志、提交或命令行参数，也不要让我把 token 贴在对话里。需要联网实测时，请我在自己的 PowerShell 里设置用户环境变量 TUSHARE_TOKEN，你只通过这个变量使用它，而且不要打印出来。

【这次的任务】新增内置的“金融指标工作台”（id com.royce.workbench.finance）：一个独立的 Python 程序（engines/finance，打包成 Tauri sidecar）从 Tushare 拉数据、计算 3 个指标，写入本地 finance.db；App 只负责读取、画图（ECharts）、管理阈值，越过阈值时通过现有提醒系统发软件内提醒。分 5 个 PR（F1–F5），我会一个一个发给你。

如果 docs/specs/finance-indicators.md 和 docs/specs/finance-codex-prompts.md 还没有在仓库里，请先告诉我，我把文件放进去后再继续。

现在先不要写代码。请先阅读上面列出的文档和相关代码（重点：apps/desktop/src/core/repositories、src/core/scheduler、src/shell/AppShell.tsx、src-tauri/src/lib.rs、src-tauri/migrations、workbenches/general/src/api.ts），然后用中文给我一份摘要：你对项目结构、现有模块、开发规矩和这次金融工作台规格的理解，以及你发现的规格与现有代码之间的冲突或疑问。等我确认后再开始 F1。
```

---

## F1：Python 取数与计算引擎（feat/finance-engine）

```
【F1】如果这是新对话，请先阅读 docs/specs/finance-codex-prompts.md 的「背景交接」并遵守其中的规矩。本次请阅读 AGENTS.md 和 docs/specs/finance-indicators.md（重点 §3、§4、§5、§8、§9.3、§10.1、§15、§16）。从最新 main 新建分支 feat/finance-engine。本 PR 只做 Python 引擎，不改 App（apps/、workbenches/）的任何代码。

0. 环境检查（我已把安装工作交给你）：检查我的电脑上有没有 Python 3.12 和 uv（运行 python --version、uv --version）。缺少的话，用 winget 安装（Python.Python.3.12、astral-sh.uv），或者用 uv python install 3.12。装好后再次验证，并告诉我装了什么、装在哪里。需要管理员权限或需要我点确认时，停下来告诉我怎么做。如果规格文件还不在仓库里，第一个提交先把 docs/specs/finance-indicators.md 和 docs/specs/finance-codex-prompts.md 加进去（docs: 添加金融指标工作台规格）。
1. 新建 engines/finance/（pyproject.toml，Python 3.12，用 uv 管理依赖）：依赖 httpx、pandas、numpy；开发依赖 pytest、respx、ruff。不要引入 tushare 包和 akshare（akshare 留到 F5）。按 spec §8.1 的目录结构组织代码。
2. finance.db：按 spec §10.1 建表，开启 WAL；用 meta.schema_version 做 Python 自己的迁移。
3. Tushare 客户端：POST https://api.tushare.pro；令牌桶限速，合计每分钟 180 次（stock_basic 每分钟 ≤ 45 次）；处理 6000 行分页；按 spec §8.3 做重试和错误分类；所有日志里的 token 都要打码。
4. 数据集：trade_cal、stock_basic（L/D/P 三种状态）、daily + adj_factor（按交易日拉，从 2015-01-01 开始）、index_daily（000300.SH）、index_dailybasic（000300.SH、399006.SZ、000001.SH，从 2005-01-01 开始）。按 spec §3.1 判断就绪时间、处理 pending；每次更新都重拉最近 3 个交易日。
5. 指标（spec §5，口径一字不改）：top5_turnover_share（沪深 A 股，不含北交所，k = ceil(N×5%)）；new_high_60d_share（后复权价、60 个市场交易日窗口、窗口内至少 45 天有交易、上市满 60 天、平高也算新高、分母只算符合条件的股票）；估值的 raw 序列和 pct_5y / pct_10y / pct_all 序列（不使用未来数据，窗口不足按 spec 规则输出空值）。每次运行都把 indicator_meta 写进 finance.db，默认阈值按 spec §7.1 写入元数据（前 5% 指标默认视图是日线）。
6. planner + 断点续传：阶段顺序 calendar → stock_basic → index → recent（最近 65 个交易日）→ backfill → compute。每个交易日的数据在一个事务里提交。用 finance.db.lock 防止同时运行两个进程。
7. 命令行和协议（spec §8.2）：update / verify / status / --version；token 只从 stdin 读取一行 JSON；stdout 每行输出一条 JSON 事件（NDJSON）；按 spec 返回退出码。
8. 测试：完成 spec §15 的 Python 部分（不联网）。另外写一个 pytest -m live 测试，读取 TUSHARE_TOKEN 环境变量，拉取 2026-11-05 一天的数据，验证前 5% 占比 = 44.2%（N=5217，k=261）和沪深300 PE-TTM = 13.59。这个测试在 CI 里默认跳过。
9. CI：在 ci.yml 里新增 Python 步骤（setup-python 3.12 + uv、ruff check、pytest），可以单独建一个 job，也可以加在 Windows job 里，总时长增加不超过 5 分钟。
10. 🔬 实测并写进文档（spec §16.2 第 1、2、4 条）：daily 是否支持 offset 分页；Tushare 积分不足和限流时实际返回的 code 和 msg；用我的 token 完整跑一次首次回补，记录耗时、finance.db 大小、index_dailybasic 从 2005 年起拉三个指数各用了几次调用。跑之前先请我设置 TUSHARE_TOKEN，跑的时候告诉我预计要多久。
11. 写 docs/finance-engine.md：怎么安装依赖、怎么运行测试、怎么在 PowerShell 里手动跑一次 update（token 通过 stdin 传入，例如从环境变量读出来通过管道传给程序，不出现在命令行参数里）、各种错误码的含义，以及第 10 条的实测记录。另外列出 60 日新高占比历史分布的 P5 / P50 / P95，供我校准阈值。

Conventional Commits 小步提交（例如 feat(finance-engine): …、test(finance-engine): …、ci: …）。确认 pnpm lint / typecheck / test 仍然通过、CI 全绿后，用 gh 开 PR。不要合并。向我报告：改了什么、测试结果、实测数据、PR 链接、需要我手动做的事。
```

## F2：sidecar 打包、token 与更新流程（feat/finance-sidecar）

```
【F2】如果这是新对话，请先阅读 docs/specs/finance-codex-prompts.md 的「背景交接」并遵守其中的规矩。本次请阅读 AGENTS.md、ARCHITECTURE.md §3、docs/specs/finance-indicators.md（重点 §1、§2、§3、§8.2、§8.4、§9.1、§9.2、§9.4、§11、§12、§16），以及 F1 写的 docs/finance-engine.md。从最新 main（已包含 F1）新建分支 feat/finance-sidecar。本 PR 不做图表，不做阈值。

1. 打包：写脚本（例如 pnpm finance:engine），用 PyInstaller 单文件模式生成 apps/desktop/src-tauri/binaries/finance-engine-x86_64-pc-windows-msvc.exe（加进 .gitignore）。在 tauri.conf.json 的 bundle.externalBin 里登记。开发时支持 WORKBENCH_FINANCE_ENGINE_DEV=1，改为用 uv run python -m finance_engine 启动。CI 在 tauri build 之前先打包 sidecar，并运行一次 finance-engine --version 做冒烟测试。
2. Rust：新增 src-tauri/src/finance.rs，实现 spec §9.1 列出的全部命令，每个命令都检查 window.label() == "main"。
   - token 用 keyring crate 存进 Windows 凭据管理器（服务名 com.royce.workbench.finance，账户 tushare），绝不返回给前端，只返回是否已设置和末 4 位。
   - 用 tauri-plugin-shell 在 Rust 端启动 sidecar：token 写进 stdin 后立即关闭 stdin；stdout 的每一行转发为 finance://event 事件；同时只允许运行一个 sidecar。
   - capabilities 里不给前端任何 shell 权限。
   - 写一个 Rust 单测，断言启动参数里不包含 token。
3. 🔬 实测（spec §16.2 第 3 条）：tauri-plugin-sql 能否用绝对路径加载 %LOCALAPPDATA%\com.royce.workbench\finance.db。能就放在那里；不能就和 workbench.db 放在同一目录，并在文档里说明原因。前端只用 select 只读访问，封装在 apps/desktop/src/core/finance/finance-reader.ts。
4. 前端数据层：apps/desktop/src/core/finance/ 下实现事件的 zod 模型，以及 LocalSidecarSource（实现 spec §9.4 的 FinanceDataSource 接口）和状态机（空闲 / 运行中 / 完成 / 部分完成 / 失败 / 重复启动）。
5. 更新触发（spec §3）：App 进程启动后约 10 秒自动触发（包括 --background 自启）；手动“立即更新”；保存 token 后触发。托盘常驻期间不定时检查；从托盘重新打开窗口、进入金融页时都不自动更新。
6. 界面骨架：
   - AppShell 侧边栏在“综合工作台”下面加“金融指标”入口，主区域能在两个工作台之间切换（新建 workbenches/finance 包，数据调用全部集中在 src/api.ts）。金融页先放占位内容 + 数据状态栏（阶段、进度、预计剩余时间、错误提示 + “去设置”按钮）+ 没有 token 时的引导卡片。
   - 设置页新增“金融指标”分区，内容按 spec §12：token 的保存、测试连接、清除；数据状态；打开数据文件夹；重建金融数据（二次确认）。
   - 首次回补前弹窗确认（文案按 spec §12）。
7. 测试：Vitest 覆盖事件解析、LocalSidecarSource 状态机（用假的 invoke 和事件）、启动触发规则（托盘重新打开不触发）。
8. 写 docs/finance-sidecar-verification.md：包括 spec §14 第 1、2、3、8 条的手动步骤，以及在凭据管理器里查看 token 条目、在任务管理器里确认 sidecar 命令行不含 token 的方法。另外记录安装包体积增加了多少。

lint / typecheck / test / prettier --check 都通过，tauri dev 手动测试通过，Windows CI 全绿。Conventional Commits 小步提交，用 gh 开 PR，不要合并。报告验证结果、截图、PR 链接，以及需要我手动做的事（比如在设置里填 token）。
```

## F3：指标页与图表（feat/finance-ui）

```
【F3】如果这是新对话，请先阅读 docs/specs/finance-codex-prompts.md 的「背景交接」并遵守其中的规矩。本次请阅读 AGENTS.md 和 docs/specs/finance-indicators.md（重点 §2、§5、§6、§9.3、§9.5、§10.2 里的 settings 键、§14 第 5 条）。从最新 main（已包含 F1、F2）新建分支 feat/finance-ui。本 PR 不做阈值的编辑和提醒，阈值线先按指标元数据里的默认值显示。

1. workbenches/finance：左列是分组指标目录（交易拥挤 / 市场宽度 / 估值，每项显示最新值）；右侧是指标页（标题 + 数据截至日期 + 立即更新按钮、当前值卡片、工具栏、折线图、说明区）。页面完全根据 finance.db 的 indicator_meta 通用渲染，以后新增指标不用改前端。
2. 图表：引入 echarts（已获同意），只按需引入 echarts/core 的 LineChart、Grid、Tooltip、DataZoom、MarkLine、Legend；自己写一个 <Chart option/> 包装组件，不引入 echarts-for-react。金融工作台整体用 React.lazy 懒加载。图表配置由纯函数 chart-option.ts 的 buildChartOption 生成。
3. 交互：
   - 范围快捷键 1 年 / 3 年 / 5 年 / 全部（默认 3 年；估值页的“全部”从 2005 年起，其它指标从 2015 年起）+ 底部缩放条。
   - 沪深300 叠加开关（副轴，默认开，记在 finance.overlay_hs300）。
   - 前 5% 指标：日线 / 月均切换，**默认日线**；月均由纯函数 monthly.ts 计算，当月未结束时标注“本月至今”。
   - 估值页：指数页签（沪深300 / 创业板指 / 上证指数）、PE-TTM / PB 切换、5 年 / 10 年 / 全部窗口切换（默认 10 年）、分位 / 原始值视图切换。
   - 用户的选择按 spec §10.2 写进 settings 键，重启后保持。
4. 深色主题下图表配色可读；空数据、更新中、错误三种状态都要有提示。
5. 测试：chart-option 和 monthly 的单测和快照测试；对照 spec §14 第 5 条逐项自测。
6. 写 docs/finance-ui-verification.md：手动步骤 + 截图（浅色和深色、三个指标页、估值的三个窗口对比）。

lint / typecheck / test / prettier --check 都通过，tauri dev 手动测试通过，CI 全绿。在 PR 描述里写明 Vite 包体积有什么变化。Conventional Commits，用 gh 开 PR，不要合并。报告验证结果、截图和 PR 链接。
```

## F4：阈值与软件内提醒（feat/finance-alerts）

```
【F4】如果这是新对话，请先阅读 docs/specs/finance-codex-prompts.md 的「背景交接」并遵守其中的规矩。本次请阅读 AGENTS.md、docs/specs/general-workbench.md §6，以及 docs/specs/finance-indicators.md（重点 §7、§10.2、§14 第 6、7 条、§15）。另外请先读现有的 apps/desktop/src/core/scheduler/、repositories/reminders.ts、shell/AppShell.tsx 里的 handleNotification。从最新 main（已包含 F1–F3）新建分支 feat/finance-alerts。

1. 迁移：新增 src-tauri/migrations/0003_finance.sql（finance_thresholds、finance_alert_states，字段和索引按 spec §10.2，带同步字段），在 lib.rs 登记 version 3。不要修改 0001 和 0002。
2. 仓库：在 core/repositories 下实现 finance-thresholds 和 finance-alert-states（UUID v7、软删除）。按 default_key 幂等地写入 spec §7.1 的 9 条默认阈值，用户删掉的默认阈值不会再自动加回来。删除的阈值 v1 不显示在回收站。
3. 阈值面板（指标页里）：可以修改、停用、删除、新增（选择序列、方向、数值、回差、备注）；图表的阈值线改为读取用户的阈值。
4. threshold-evaluator 纯函数（spec §7.2）：只在越线时提醒；有回差；首次计算和修改阈值后静默设置状态；补算多天只提醒一次，而且最新一天必须仍在阈值之外；重算的日子不重复提醒；用 finance://event 的 done.new_dates 判断哪些日子是新算的。
5. 写入提醒（spec §7.3）：source='manual'、source_workbench='com.royce.workbench.finance'、priority=2、due_at=now。新建提醒和写 finance_alert_states 在同一个 execute_batch 事务里完成。同一次更新中有 3 条及以上越线时合并成一条。提醒页给这类提醒显示“金融”标记，可以正常勾选完成。点击通知条主体时，如果是金融提醒，就跳到对应的指标页（扩展 handleNotification / reminderTarget，并补单测）。
6. 左列和当前值卡片显示“已高于 / 已低于阈值”标记。
7. 测试：spec §15 的 TypeScript 部分全部完成（评估器的各种情形、仓库、事务回滚、默认阈值幂等写入、合并规则、点击跳转）。
8. 写 docs/finance-verification.md：完整列出 spec §14 验收表 1–10 条，逐条写明结果（自动 / 手动）。手动测试第 7 条时，用测试数据库或假数据源模拟 44% → 46% → 46.5% → 43.5% → 45.5% 这组数据，不要改动我的个人数据库。另外附上 F1 文档里的 60 日新高历史分布，供我校准默认阈值。

lint / typecheck / test / prettier --check 都通过，tauri dev 手动测试通过（包括窗口在托盘时先唤起窗口再弹通知），CI 全绿。Conventional Commits，用 gh 开 PR，不要合并。报告验证结果、截图和 PR 链接。
```

## F5（可选）：AKShare 备用源（feat/finance-akshare）

```
【F5】如果这是新对话，请先阅读 docs/specs/finance-codex-prompts.md 的「背景交接」并遵守其中的规矩。本次请阅读 AGENTS.md 和 docs/specs/finance-indicators.md（重点 §4.1、§4.3、§11、§16.1 第 9、10 条）。从最新 main（已包含 F1–F4）新建分支 feat/finance-akshare。

1. 先实测体积，再动手做功能：把 akshare 作为可选依赖加进 engines/finance（extra 名为 akshare），分别打包“带 akshare”和“不带 akshare”两个 sidecar，记录 exe 大小、安装包大小和启动耗时的差异。把数据告诉我，然后停下来，等我决定是否打包进正式版。在我决定之前，只能继续第 2–4 步中“不影响默认打包”的部分。
2. finance_engine/sources/akshare_fallback.py：只为口径相同的数据做备用（spec §4.3 表格中标 ✅ 的三项）：
   - 交易日历：tool_trade_date_hist_sina
   - 沪深300 收盘：stock_zh_index_daily("sh000300") 或 index_zh_a_hist("000300")
   - 目标日是今天时的全市场成交额快照：stock_zh_a_spot_em，过滤掉北交所
   只有 Tushare 失败、而且设置开关打开时才使用。写入的数据 source 记为 akshare。akshare 用懒加载导入；没有安装时自动跳过备用源，不能报错。
3. App：设置页加“Tushare 失败时使用 AKShare 备用源”开关（settings 键 finance.akshare_fallback，默认 true，通过 stdin JSON 传给引擎）；图表上对来自备用源的数据点做标注。
4. 测试：模拟 Tushare 失败时切换到备用源、akshare 未安装时自动跳过、来源标注正确；估值和历史个股数据绝不能使用 AKShare 的数据（写一个单测断言）。
5. 写 docs/finance-akshare.md：体积实测数据、启用方法、限制（创业板指和上证指数的估值、历史个股数据都没有口径一致的 AKShare 替代）。

lint / typecheck / test / ruff / pytest 都通过，CI 全绿。Conventional Commits，用 gh 开 PR，不要合并。报告体积数据、验证结果和 PR 链接。
```
