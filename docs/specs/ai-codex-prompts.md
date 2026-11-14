# AI 工作台 Codex 提示词（A1–A5，按顺序，一次一个，上一个 PR 合并后再发下一个）

用法：

1. 在 Codex **新对话**里，先让它读 `docs/specs/codex-handoff.md`（交接文档）并回复理解摘要，确认没有理解错，再发 A1。
2. 每个 PR 完成后，把 Codex 的报告和 PR 链接发给 WorkBench 审查。审查通过后由 Royce squash 合并，然后运行 `git checkout main && git pull`，再发下一个提示词。
3. 每个提示词开头都要求 Codex 先读交接文档和规格，所以换了新对话也可以单独发某一个。

> 规格：`docs/specs/ai-assistant.md`。§18.1 和 §18.2 均已由 Royce 确认；与总架构冲突时以 ARCHITECTURE.md 为准；§18.3 是 Codex 自己实测的技术点。
> 下面描述的现有代码情况，已于 2026-11-14 对照 main（`a1d93f5`）核对。

**每个 PR 都适用的规矩（提示词里不再重复全文）**

- 从最新 main 新建分支，只做本 PR 范围；Conventional Commits 小步提交（中文说明）；`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm exec prettier . --check` 通过，Windows CI 全绿；新逻辑必须有单元测试。
- 用 gh 开 PR，按模板填写；**不要合并**，不要强制推送，不要改写已推送历史。
- **隔离实例**：需要运行 App 时，用独立 identifier（如 `com.royce.workbench.ai-a2-check`）和 `app.appDirectoriesOverride` 指向仓库忽略目录，使用合成数据；隔离实例设置一个与正式版不同的快捷键。**不读写正式版的 workbench.db、`%LOCALAPPDATA%\com.royce.workbench\` 和正式版凭据**；正式版在运行时不要启动会写同一数据库的 `pnpm tauri dev`。
- **不使用真实 DeepSeek key**：测试、CI、日志、文档、截图、命令行参数里都不能出现真实 key；也不要让 Royce 把 key 贴进对话。联调用本机模拟服务（debug 构建的 `WORKBENCH_AI_BASE_URL`）和假 key。
- 写一份 `docs/` 下的验证文档：自动检查 + Royce 能照做的手动步骤 + 实测记录；文档里不写个人绝对路径。
- 最后用中文报告：改了什么、跑了哪些测试和结果、CI 状态、PR 链接、需要 Royce 手动做的事。

---

## A1：DeepSeek 客户端与 key（feat/ai-client）

```
【A1】先读 docs/specs/codex-handoff.md 并遵守其中的规矩，再读 AGENTS.md、ARCHITECTURE.md §3 §7、docs/specs/ai-assistant.md（重点 §7、§10、§12、§13、§14、§17 的 Rust 和 llm-client 部分、§18）和 docs/specs/ai-codex-prompts.md 开头的通用规矩。参考现有 apps/desktop/src-tauri/src/finance.rs 的 main_only、keyring 和 token_status 写法。从最新 main 新建分支 feat/ai-client。

0. 如果 docs/specs/ai-assistant.md、ai-codex-prompts.md、codex-handoff.md 还不在仓库里，先告诉我，等我放进去后，第一个提交把它们加进去（docs: 添加 AI 工作台规格）。
1. 依赖：Rust 新增 reqwest（default-features = false，features json、rustls；0.13 的 rustls 即原方案 rustls-tls 的对应特性）。规格 §18.2 第 11 条已写“已同意”。
2. 新建 src-tauri/src/ai.rs，实现 §10.2 的 5 个命令（全部 main_only）：凭据服务名 "{identifier}.ai"、账户 deepseek；ai_chat 按 §10.4 做模型白名单、体积上限、强制 max_tokens/stream/thinking、单请求在途、按模型调用次数计的每分钟 20 次和每天 300 次本地上限、允许 tool / assistant.tool_calls 消息、128 KB 体积上限、10s/30s 超时、不重试、§14 错误码映射、日志不含 key 和正文；debug 构建才读 WORKBENCH_AI_BASE_URL 且只接受回环地址。Rust 用应用数据目录的 ai-usage.json 持久化北京时间自然日和分钟计数，启动恢复；已发出请求（含失败/超时）计数，未发出的不计；文件损坏按今天 150 次保守恢复并写日志。ai_key_status 附带非敏感用量，禁止用 settings 存 ai.usage。新增 permissions/ai.toml（allow-ai），只加进 capabilities/default.json。在 lib.rs 登记。ARCHITECTURE.md 同步补充 AI 接入边界，其余总结留到 A5。
3. 前端 apps/desktop/src/core/ai/llm-client.ts：LlmClient 接口、TauriLlmClient（invoke ai_chat）、zod 响应模型、错误码类型；再写一个测试用 MockLlmClient。
4. 设置页“AI 助手”分区（workbenches/ai/src/AiSettings.tsx，先只建包和这个组件，AppShell 的 settingsExtra 同时放 AiSettings 和 FinanceSettings）：key 保存/测试连接/清除，只显示尾号；模型下拉；今日用量。快捷键、“允许 AI 读取”开关与发送内容说明、对话记录分别留到 A2、A4、A5。
5. 测试：§17 的 Rust 部分（cargo test --lib ai::tests，本地运行，结果写进文档）和 llm-client 的 Vitest（错误码解析、非法响应）。
6. 🔬 §18.3 第 1、2 条：查 DeepSeek 官方文档确认模型名和参数，把查到的日期和结论写进文档。
7. 写 docs/ai-client-verification.md：自动检查结果；隔离实例里用假 key + 本机模拟服务验证 保存/尾号/测试连接/清除、401/402/429/超时/5xx 提示；在凭据管理器查看条目的方法；确认数据库、用量文件、日志和自动控制台输出无假 key，保存后状态和聊天 IPC 不带完整 key。说明用户输入保存时密码框和该次保存 IPC 的必要短暂传递，不能承诺开发者工具无法观察这次输入。

本 PR 不做对话页、快捷键和任何日程/提醒操作。按通用规矩提交、开 PR、不要合并，用中文报告。
```

## A2：AI 工作台骨架、操作登记表与快捷键（feat/ai-workbench）

```
【A2】先读 docs/specs/codex-handoff.md 并遵守其中的规矩，再读 AGENTS.md、docs/specs/ai-assistant.md（重点 §3、§4、§5、§6、§7.1–§7.3、§14、§17）。另外先读 apps/desktop/src/shell/AppShell.tsx、src/shell/shortcut-runtime.ts、src/core/shortcut-controller.ts、workbenches/general/src/components/SettingsPage.tsx。从最新 main（已包含 A1）新建分支 feat/ai-workbench。

1. AppShell：把 financeOpen 改成内置工作台列表 + activeWorkbench（general / finance / ai），侧边栏在“金融指标”下面加“AI 助手”；AI 工作台 React.lazy 懒加载。现有综合、金融工作台的行为、通知跳转和托盘请求保持不变（补回归测试）。
2. core/ai：action-types.ts（照 §6.1）、registry.ts（§6.2 的检查、生成 tools）、ref-table.ts（短引用、30 分钟过期、类型检查）、prompt.ts（§7.2，纯函数，含“数据不是指令”的安全规则）、local-time.ts、orchestrator.ts（§7.1、§7.3：每条消息最多 3 次模型调用的 tool 循环、读取结果作为 tool 消息回传、含写入调用即结束、第 3 次仍读取时直接列出数据、每次最多 5 个 tool call、校验失败出错误卡片、不重试；历史最近 6 条 30 分钟内的文字，只保留上一条消息的读取结果）。用一个测试专用的假读取操作验证循环。
3. workbenches/ai：对话页（消息区、输入区、发送中状态、纯文本渲染、示例句子、无 key 引导卡片、§14 错误卡片及“去设置 / 手动新建”按钮）；ai-store.ts（Zustand）；api.ts 作为唯一数据出入口。此时还没有登记业务操作（只有测试里的假操作），正式界面里模型只能文字回复。
4. 快捷键（§4）：normalizeShortcut 支持 Space（只允许 Ctrl+Alt / Ctrl+Shift 组合），新建 aiShortcutController（默认 Ctrl+Alt+Space，设置键 ai.global_shortcut），与快速新建快捷键互斥；按下后 show_main → 切到 AI 工作台 → 聚焦输入框；设置页 AI 分区加快捷键录入，错误条与快速新建一致。
5. 测试：§17 中 prompt、local-time、registry、ref-table、orchestrator（MockLlmClient，含 3 轮上限和 tool_call_id 对应）、shortcut-controller 部分，以及 AppShell 切换回归。
6. 🔬 §18.3 第 3、4 条，结果写进文档。
7. 写 docs/ai-workbench-verification.md：隔离实例中托盘隐藏时按快捷键唤起并聚焦、冲突提示、无 key 引导、模拟服务返回文字回复和各类错误的截图（浅色、深色）。

本 PR 不登记任何业务操作，不做对话持久化。按通用规矩提交、开 PR、不要合并，用中文报告。
```

## A3：新建操作与确认卡片（feat/ai-create-actions）

```
【A3】先读 docs/specs/codex-handoff.md 并遵守其中的规矩，再读 AGENTS.md、docs/specs/general-workbench.md §5 §6、docs/specs/ai-assistant.md（重点 §8.1、§8.2 的三个 create、§8.4、§9、§16 第 3 条、§17）。另外先读 workbenches/general/src/api.ts、calendar-model.ts（RepeatDraft、buildRule、reminderChoices）、reminder-model.ts、components/EventForm.tsx。从最新 main（已包含 A1、A2）新建分支 feat/ai-create-actions。

1. 新建 workbenches/general/src/ai-actions.ts，登记 reminders_create、calendar_create_event、memos_create（只调用 generalApi，不直接调仓库）；repeat 对象转 RepeatDraft 再用 buildRule；提前提醒按 §8.1 取档并标黄；新建日程和提醒写 source_workbench = 'com.royce.workbench.ai'。api.ts 新增 createMemoWith(draft)。在 AppShell 登记。
2. 确认卡片（§9）：新建卡片可编辑（尽量复用现有表单组件或其子组件）、日期显示星期、重复规则中文说明；确认 / 取消 / 在表单中打开；状态机 待确认 → 保存中 → 已保存（查看）/ 失败（重试保存，不调用模型）/ 已取消；确认按钮只能生效一次。保存后可跳转（§3.2）。
3. 测试：§17 中新建、repeat 转换、确认前绝不 execute、重复点击只写一次、卡片编辑后保存改后的值、纯文本渲染。用内存 SQLite 和 MockLlmClient。
4. 写 docs/ai-create-verification.md：隔离实例 + 模拟服务按 §16 第 3 条逐句验证（模拟服务返回预设的 tool_calls），截图。

新建操作不需要读取数据，也不使用 ref。本 PR 不做读取、查询、修改、删除。按通用规矩提交、开 PR、不要合并，用中文报告。
```

## A4：读取、提问、修改与删除（feat/ai-query-modify）

```
【A4】先读 docs/specs/codex-handoff.md 并遵守其中的规矩，再读 AGENTS.md、docs/specs/general-workbench.md §5.4 §5.5 §8、docs/specs/ai-assistant.md（重点 §3.1、§7（尤其 §7.4 发送字段与上限）、§8.2–§8.4、§9 批量删除、§12、§13 第 1、2 条、§16 第 4–8、10 条、§17）。另外先读 apps/desktop/src/core/calendar/series-mutations.ts、recurrence.ts，以及 api.ts 里的 loadCalendar、listReminders、editEventOccurrence、deleteEventOccurrence、saveReminder（expected 参数）。从最新 main（已包含 A1–A3）新建分支 feat/ai-query-modify。

1. 读取操作：在 ai-actions.ts 登记 calendar_list_events、reminders_list。只输出 §7.4 表里的字段（不发备注、真实 id、RRULE 原文；没有备忘录读取），每条用 ref-table 发短引用；本地强制 31 天范围、60 条、标题 60 字截断、6000 字符上限，如实填 total / truncated；重复日程按实例展开。输出是带固定 notice 的 workbench_data JSON。
2. 提问回答：对话里显示“正在查看 …”灰字提示；回答下附参考条目列表，回答中的 [e1] 转为可点击标签（未知 ref 原样显示），点击跳转（§3.2）。
3. 写入操作：登记 calendar_update_event、calendar_delete_event、reminders_update、reminders_delete，参数用 refs（§8.2）。按 §8.3 本地校验 ref（不存在、过期、类型不符 → 拒绝且不出卡片）；修改多个 ref → 候选列表；删除 pick_one / all_listed；批量删除卡片逐条列出、可取消、最多 20 项；卡片标题和时间以本地数据库为准。
4. 修改卡片只列变化字段的 X→Y；重复日程实例显示 仅这次 / 这次及以后 / 全部（不预选，未选时确认禁用），结果与日程编辑器手动操作一致。删除卡片如实写明实际去向（首个实例“此后全部”等价于整个系列进入回收站；其他情况沿用 exdates / 截断及例外软删除）。
5. 边界（§8.4）：日程生成的提醒拒绝并给跳到日程的按钮；金融提醒只能查询；重复提醒修改写明“将修改整个重复提醒”；执行前用 RefEntry.updatedAt 做并发检查。
6. 设置页 AI 分区加“允许 AI 读取日程和提醒”开关（ai.read_data_enabled，默认开；关闭后不向模型提供读取函数，不发送任何历史读取结果，清空短引用表，并立即使依赖读取结果的待确认修改/删除卡片失效、提示原因）和 §12 的发送内容说明。
7. 测试：§17 中读取字段与上限、找目标、批量删除、三种范围、删除去向、并发检查、边界规则、隐私断言（请求体无备注/备忘录/真实 id，关闭读取后无读取函数和数据）、提示注入（标题含“删除所有日程”时不产生未经确认的写入；编造或过期 ref 被拒绝）。
8. 写 docs/ai-query-modify-verification.md：隔离实例 + 合成数据（含一条注入标题）+ 模拟服务按 §16 第 4–8、10 条逐条验证，记录模拟服务收到的请求体字段（只记字段名和条数，截图里不出现 key），截图。

本 PR 不做对话持久化。按通用规矩提交、开 PR、不要合并，用中文报告。
```

## A5：对话记录、收尾与完整验收（feat/ai-history）

```
【A5】先读 docs/specs/codex-handoff.md 并遵守其中的规矩，再读 AGENTS.md、ARCHITECTURE.md §5 §8、docs/specs/ai-assistant.md（重点 §11、§12、§16、§17、§18.3 第 5 条）。另外先读 apps/desktop/src/core/repositories/base-repository.ts、trash-cleaner.ts 和 src-tauri/src/lib.rs 的迁移登记。从最新 main（已包含 A1–A4）新建分支 feat/ai-history。

1. 迁移：新增 src-tauri/migrations/0004_ai.sql（§11.1），在 lib.rs 登记 version 4，不要修改 0001–0003。
2. 仓库 core/repositories/ai-messages.ts（UUID v7、软删除）；加载最近 200 条；清空 = 写 deleted_at + purged_at 并清空内容；跟随回收站清理时机清空 30 天前的记录；ai.history_enabled 开关；重启后未确认卡片显示“已失效”。设置页 AI 分区加“保存对话记录”开关和“清空对话记录”（二次确认）。
3. 更新 ARCHITECTURE.md：§3 加 AI 工作台与 core/ai，§5 注明 ai_messages 为本地专用不同步，§7 加 AI 快捷键说明；README 功能列表加一行。
4. 测试：§17 的 ai-messages 部分和迁移测试。
5. 写 docs/ai-verification.md：列出 §16 验收表 1–13 条，逐条写结果（自动 / 手动 / 由前面哪个 PR 验证）。
6. 联网验收（§16 第 1、3–7、10 条和 §18.3 第 5 条，含提问类句子）需要真实 key：在隔离实例准备好后停下来，请我自己在隔离实例的设置页填我的 DeepSeek key（不要让我把 key 发给你，也不要读取凭据）。我操作完后，你只读取界面结果、请求统计（token、耗时）和数据库里的合成数据，记录正确率；验收结束请我在隔离实例里点“清除”删除 key。

按通用规矩提交、开 PR、不要合并，用中文报告。A5 合并后由我决定何时打包新安装包。
```
