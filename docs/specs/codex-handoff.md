# WorkBench · Codex 交接文档（AI 工作台阶段）

> 给一个**全新的 Codex 窗口**看：你没有之前的记忆，先读完本文件，再按「第一个任务」做。
> 本文件放在仓库 `docs/specs/codex-handoff.md`。内容已于 2026-11-14 对照 GitHub `roycelee597/WorkBench` 的 main（`a1d93f5`）核对。

## 1. 我是谁、怎么沟通

- 我叫 Royce，计算机专业学生，主要会 Python，正在学 TypeScript，刚开始用 GitHub。
- **全程用简体中文**。每一步说明做了什么、为什么、我怎么验证。
- 需要我手动操作（安装软件、登录、填 key、点确认）时，停下来，把步骤一条一条写清楚。
- 规格没写清楚的地方先问我，不要猜。一次只做被要求的那件事，不擅自加功能、换技术栈或加依赖。

## 2. 项目概况

| 项目     | 内容                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称     | WorkBench：模块化桌面工作台（一个主程序 + 多个「工作台」），开源 MIT                                                                                                    |
| 仓库     | 公开仓库 https://github.com/roycelee597/WorkBench ，默认分支 `main`                                                                                                     |
| 应用 id  | `com.royce.workbench`（Tauri identifier）                                                                                                                               |
| 开发环境 | Windows；以下命令都在**仓库根目录**运行                                                                                                                                 |
| 技术栈   | Tauri 2 + React 19 + TypeScript（strict）+ Vite、Tailwind + shadcn/ui、Zustand、SQLite（tauri-plugin-sql）、zod、dayjs + rrule、Vitest、ESLint + Prettier。**不要更换** |
| 包管理   | pnpm 11.25.0 monorepo，Node 24                                                                                                                                          |
| 金融引擎 | Python 3.12 + uv（`engines/finance`，打包成 Tauri sidecar）                                                                                                             |
| CI       | `.github/workflows/ci.yml`：「Windows CI」（lint、prettier、typecheck、test、sidecar 冒烟、`tauri build --no-bundle`）和「金融引擎 Python」（ruff、pytest）             |

常用命令：`pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm exec prettier . --check`、`pnpm dev`（= `pnpm --filter desktop tauri dev`）。Rust 单测：`cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib <模块>::tests`（CI 不跑，本地跑并写进验证文档）。

## 3. 仓库结构

```text
├─ AGENTS.md / ARCHITECTURE.md / README.md / CONTRIBUTING.md / CHANGELOG.md
├─ apps/desktop/                 # Tauri 主程序
│  ├─ src/core/                  # db、repositories（所有读写入口）、scheduler（提醒调度）、calendar（重复规则）、finance（只读 finance.db）
│  ├─ src/shell/                 # AppShell 侧边栏、软件内通知条、快速新建窗口、快捷键运行时
│  └─ src-tauri/                 # Rust：database.rs（execute_batch）、desktop.rs（托盘、显示/隐藏主窗口）、quick_create.rs、finance.rs（凭据、sidecar）
│     ├─ migrations/             # 0001_init、0002_reminder_scheduler、0003_finance（只能新增，不能改旧的）
│     ├─ capabilities/ permissions/
│     └─ tauri.conf.json
├─ packages/ui                   # 共享组件 Button、Dialog
├─ packages/sdk、packages/manifest # 空入口（Phase 2 插件运行时还没做）
├─ workbenches/general           # 综合工作台：今天 / 备忘录 / 日程 / 提醒 / 设置 / 回收站；数据调用集中在 src/api.ts
├─ workbenches/finance           # 金融指标工作台；数据调用集中在 src/api.ts
├─ engines/finance               # Python 引擎（Tushare 取数、算指标，写 finance.db）
└─ docs/                         # 规格（docs/specs/）和各功能验证文档
```

## 4. 当前状态

- **Phase 1 综合工作台已完成**：备忘录（Tiptap，Markdown 存储）、日程（FullCalendar，rrule 重复，仅此次 / 此后 / 全部）、提醒事项 + 调度器（精确定时 + 30 秒兜底，贪睡 10 分钟，启动补发）、回收站（软删除，30 天自动清空内容、保留墓碑）、今天页、托盘、开机自启（默认关）、单实例、全局快捷键 `Ctrl+Alt+N` 呼出快速新建窗口。
- **金融指标工作台 F1–F5 已全部合并**（Python 引擎、sidecar 与 token、图表、阈值提醒、可选 AKShare 备用源；AKShare 默认不打包）。
- 文档清理 PR #26 已合并（main `a1d93f5`）。
- Dependabot PR #18–#22 还开着，**不在本阶段范围内，不要碰**。
- **下一阶段：AI 工作台**（DeepSeek，一句话新建 / 查询 / 修改 / 删除日程、提醒，新建备忘录；AI 可以在限定范围内读取日程和提醒来回答「下午我有空吗」这类问题，所有写入都要我在确认卡片上点确认）。

## 5. 工作流程

1. 从最新 main 新建分支：`feat/…`、`fix/…`、`docs/…`、`chore/…`。一个 PR 只做一件事。
2. 小步提交，Conventional Commits（中文说明），例如 `feat(ai): 新增 DeepSeek 客户端`。
3. 本地检查全部通过后 push，用 `gh pr create` 开 PR，按 `.github/pull_request_template.md` 填写。
4. **不要合并 PR**（除非我明确让你合并），不要强制推送，不要改写已推送的历史。
5. 用中文向我报告：改了什么、跑了哪些测试和结果、CI 状态、PR 链接、需要我手动做的事。
6. 我把报告拿去审查；通过后**由我 squash 合并**，然后我运行 `git checkout main && git pull`，再给你下一个任务。

## 6. 硬性规矩

1. **不碰正式版数据**：我电脑上装着正式版 WorkBench。它的数据在 `%APPDATA%\com.royce.workbench\workbench.db` 和 `%LOCALAPPDATA%\com.royce.workbench\`，凭据在 Windows 凭据管理器的 `com.royce.workbench.*` 条目。开发和验收时**不得读写这些数据**。
   - 需要运行 App 时，用独立 identifier（如 `com.royce.workbench.ai-a2-check`）+ `app.appDirectoriesOverride` 指向仓库里被 Git 忽略的目录（如 `dist/ai-check/app`），通过 `tauri dev --config <json>` 启动，只用合成数据。做法可参考 `docs/finance-verification.md` 的「准备手动测试缓存」。
   - 隔离实例的凭据条目会自动变成 `<隔离 identifier>.ai`，不会碰到正式版。
   - 隔离实例要在设置里换一个和正式版不同的全局快捷键。
   - 正式版在写同一个数据库时，不要运行会写它的 `pnpm tauri dev`。
2. **密钥**：Tushare token、DeepSeek API key 都是密钥。绝不能出现在代码、测试、CI、日志、文档、截图、提交或命令行参数里；不要让我把密钥贴进对话。密钥只存 Windows 凭据管理器（Rust `keyring`），前端只能看到末 4 位。测试用假 key 和本机模拟服务。
3. **AI 数据边界**：发给 DeepSeek 的已存数据只限 `docs/specs/ai-assistant.md` §7.4 列出的字段、范围和条数；日程/提醒的备注、任何备忘录（标题和正文）、真实 id、key 永远不发。已存数据只能作为带说明的数据放进 tool 结果，不能当指令；所有写入都必须经过确认卡片。
4. **通知**：只用软件内通知条，不用 Windows 系统通知或 `tauri-plugin-notification`。窗口在托盘时先显示并聚焦主窗口，再弹通知条。
5. **数据层**：所有读写走 `apps/desktop/src/core/repositories`；只软删除；改表只能新增迁移；业务表带 `id`（UUID v7）、`created_at`、`updated_at`、`deleted_at`、`device_id`、`deletion_group_id`、`purged_at`。`reminders.source` 只能是 `manual` / `event`（有 CHECK 约束），区分来源用 `source_workbench`。
6. **Rust 只做系统能力**，业务逻辑写在 TypeScript。新的 Rust 命令都要检查 `window.label() == "main"`，并在 `permissions/*.toml` 和 `capabilities/default.json` 里只给主窗口。
7. **打包**：只改文档的 PR 不用重新打包安装包；不是每个 PR 都打包，一个阶段完成后再打包。
8. **文档**：不写个人绝对路径，用「在仓库根目录运行」、相对路径或 `%LOCALAPPDATA%\com.royce.workbench\` 这类通用写法。
9. 不提交 `.env`、数据库文件、构建产物或密钥。TypeScript 禁止 `any`（确需时写注释说明）。新逻辑必须有单元测试。

## 7. 规格在哪里

- 总体：`ARCHITECTURE.md`（唯一设计依据）、`AGENTS.md`（给 Codex 的规则）。
- 综合工作台：`docs/specs/general-workbench.md`。
- 金融工作台：`docs/specs/finance-indicators.md`、`docs/specs/finance-codex-prompts.md`。
- **AI 工作台（本阶段）**：`docs/specs/ai-assistant.md`（规格）和 `docs/specs/ai-codex-prompts.md`（A1–A5 提示词与通用规矩）。与总架构冲突时以 ARCHITECTURE.md 为准；§18.1、§18.2 均已确认（含 reqwest）；用量由 Rust 独立持久化到应用数据目录的 ai-usage.json，不经业务库。§18.3 是你实现时要自己实测、写进文档的技术点。
- 这三份 AI 文件（`ai-assistant.md`、`ai-codex-prompts.md`、本文件）如果还不在仓库里，先告诉我；我放进工作区后，在 A1 的第一个提交里加进去（`docs: 添加 AI 工作台规格`）。

## 8. 第一个任务

1. 读本文件、`AGENTS.md`、`ARCHITECTURE.md`、`docs/specs/general-workbench.md`、`docs/specs/ai-assistant.md`、`docs/specs/ai-codex-prompts.md`。
2. 再读相关代码：`apps/desktop/src/shell/AppShell.tsx`、`src/core/shortcut-controller.ts`、`src/core/repositories/`、`src/core/calendar/series-mutations.ts`、`src-tauri/src/lib.rs`、`src-tauri/src/finance.rs`（keyring 与 main_only 写法）、`workbenches/general/src/api.ts`、`calendar-model.ts`。
3. **先不要写代码**。用中文给我一份摘要：你对项目结构、现有模块、开发规矩和 AI 工作台规格的理解，以及你发现的规格与现有代码之间的冲突或疑问。
4. 我确认后，按 `docs/specs/ai-codex-prompts.md` 的 **A1** 开始（分支 `feat/ai-client`）。
