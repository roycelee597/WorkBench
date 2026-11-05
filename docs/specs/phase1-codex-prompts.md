# Phase 1 Codex 提示词（按顺序，一次一个，上一个 PR 合并后再发下一个）

每个提示词开头都已包含「先读文档、从最新 main 开分支」。每个 PR 完成后，把 Codex 的报告和 PR 链接发给 WorkBench 审查，合并后 `git checkout main && git pull` 再发下一个。

---

## PR 1：数据层（feat/data-layer）

```
请先阅读 ARCHITECTURE.md、AGENTS.md 和 docs/specs/general-workbench.md（本次重点 §8、§10）。从最新 main 新建分支 feat/data-layer，只做数据层，不做任何界面：
1. 接入 tauri-plugin-sql（SQLite），数据库放应用数据目录。建立迁移机制；按 ARCHITECTURE.md §4 加上 spec §10 的新增字段与索引，写成迁移文件（若仓库里还没有任何已发布迁移，可直接写进 0001_init.sql）。
2. 在 apps/desktop/src/core/repositories 实现 memos、events、reminders、settings 仓库：UUID v7、毫秒时间戳、device_id、软删除，查询默认排除已删除；提供 listDeleted / restore / purgeContent。
3. 实现回收站清理函数：deleted_at 早于 30 天的记录清空内容字段、保留墓碑；记录 last_trash_purge_at。
4. 实现日程展开工具：给定时间范围，用 rrule 展开重复日程，应用 exdates 和例外日程（recurrence_id / original_start_at）。实现「仅此次 / 此后全部 / 全部」三种修改与删除的纯函数。
5. 为以上全部写 Vitest 单测（仓库层可用内存 SQLite 或适配层 mock），重点覆盖重复例外三种情况和 30 天清理边界。
6. pnpm lint、typecheck、test、prettier --check 全部通过。Conventional Commits，推送后用 gh 开 PR，报告验证结果和 PR 链接。不要做界面。
```

## PR 2：主界面框架 + 备忘录（feat/memos）

```
请先阅读 ARCHITECTURE.md、AGENTS.md 和 docs/specs/general-workbench.md（本次重点 §2、§4、§8、§9）。从最新 main 新建分支 feat/memos：
1. 主界面布局：左侧工作台切换栏（底部设置、回收站入口），综合工作台四个页签：今天/备忘录/日程/提醒事项（今天、日程、提醒先放占位页）。主题跟随系统，可在设置切换浅/深。
2. workbenches/general 实现备忘录：左列表右编辑；Tiptap 所见即所得，支持 spec §4 列出的格式，正文以 Markdown 存储；500ms 防抖自动保存；置顶、标签（带补全）、搜索与标签筛选；排序按 spec。
3. 所有数据调用只写在 workbenches/general/src/api.ts。
4. 回收站页面：列出已删除的备忘录（预留日程、提醒分组），可恢复、永久删除；应用启动时执行一次 30 天清理，之后每天一次。
5. 单测：Markdown 往返（每种格式）、api.ts 关键逻辑。
6. lint、typecheck、test、prettier --check、tauri dev 手测通过。Conventional Commits，gh 开 PR，报告验证结果、截图说明和 PR 链接。
```

## PR 3：日程（feat/calendar）

```
请先阅读 ARCHITECTURE.md、AGENTS.md 和 docs/specs/general-workbench.md（本次重点 §5）。从最新 main 新建分支 feat/calendar：
1. 日程页：月/周/日视图（默认周，周一开始），点击空白新建，拖动改时间，拖边缘改时长。可选用成熟日历组件（说明选型理由与许可证），或自行实现。
2. 新建/编辑表单：标题、开始、结束、全天、备注、6 色、重复（spec §5.3 全部预设 + 结束条件）、提前提醒（默认读设置，初始为不提醒）。
3. 修改/删除重复日程实例时弹窗「仅此次 / 此后全部 / 全部」，调用 PR 1 的纯函数。
4. 提前提醒联动按 spec §5.5：自动生成/同步/删除关联提醒（source='event'）。本 PR 只负责数据联动，通知由下一个 PR 实现。
5. 删除日程时关联提醒一同进回收站，恢复时一同恢复；回收站页加入日程分组。
6. 单测覆盖联动逻辑。lint、typecheck、test、prettier、tauri dev 手测通过。Conventional Commits，gh 开 PR，报告验证结果和 PR 链接。
```

## PR 4：提醒事项 + 调度器 + 托盘（feat/reminders）

```
请先阅读 ARCHITECTURE.md（§7）、AGENTS.md 和 docs/specs/general-workbench.md（本次重点 §6、§7）。从最新 main 新建分支 feat/reminders：
1. 提醒页：今天/计划中/全部/已完成四组；字段、勾选完成、优先级、重复按 spec §6；由日程生成的提醒显示日程图标并限制改时间。
2. apps/desktop/src/core/scheduler：精确定时 + 30 秒轮询兜底；写 notified_at 防重复；贪睡固定 10 分钟；重复提醒完成或触发后推进下一次；启动时合并补发错过的提醒。用假时间写单测。
3. 软件内通知（不要用 Windows 系统通知 / tauri-plugin-notification）：到点在应用内弹出通知条（标题 + 备注首行），按钮「完成」「稍后 10 分钟」；主窗口若在托盘则先显示并聚焦再弹。错过补发同样用软件内通知条。
4. 托盘：关窗隐藏到托盘，菜单 打开/新建提醒/退出，双击打开。
5. 开机自启（tauri-plugin-autostart）：默认关闭，设置页可开关；首次创建带时间提醒或带提前提醒的日程时弹一次提示，记录 autostart_prompted。
6. 回收站页加入提醒分组。lint、typecheck、test、prettier、tauri dev 手测（含软件内到点通知条）通过。Conventional Commits，gh 开 PR，报告验证结果和 PR 链接。
```

## PR 5：今天页 + 快速新建（feat/today）

```
请先阅读 ARCHITECTURE.md、AGENTS.md 和 docs/specs/general-workbench.md（本次重点 §3、§7、§12）。从最新 main 新建分支 feat/today：
1. 今天页：今天的日程、今天和逾期提醒、置顶备忘录三个区块，交互与空状态按 spec §3；跨午夜自动刷新。
2. 全局快捷键（tauri-plugin-global-shortcut）默认 Ctrl+Alt+N，设置页可改，注册失败提示冲突；呼出置顶居中的小型「快速新建」窗口，可切换备忘/日程/提醒，回车保存，Esc 关闭，应用隐藏时也可用。
3. 对照 spec §12 验收标准逐条自测，在 PR 说明中列出每条结果。
4. lint、typecheck、test、prettier、tauri dev 通过。Conventional Commits，gh 开 PR，报告验证结果和 PR 链接。
```
