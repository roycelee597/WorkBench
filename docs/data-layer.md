# 数据层开发与验证

本次只提供 SQLite、仓库、回收站清理和重复日程纯函数；没有新增界面、提醒调度器或通知功能。设计依据为 `ARCHITECTURE.md` §5 和 `docs/specs/general-workbench.md` §8、§10。

## 初始化与迁移

- 官方 SQL 插件在启动时预加载 `sqlite:workbench.db` 并执行 `0001_init.sql`。Windows 文件位于 `%APPDATA%\com.royce.workbench\workbench.db`，不放入仓库。
- 后续改表必须新增迁移文件，并在 `src-tauri/src/lib.rs` 中登记递增版本；不能修改已发布迁移。SQL 插件保存已执行迁移，重启不会重建表。
- `initializeDataLayer()` 返回同一个初始化 Promise；首次生成 UUID v7 设备标识并保存在 `settings.device_id`，随后使用持久化标识。
- SQL 插件的独立请求可能使用不同连接，因此不能在多次 IPC 间拼接 `BEGIN/COMMIT`。通用 Rust `execute_batch` 使用插件管理的同一 SQLite 事务执行仓库给出的绑定参数语句，失败整体回滚。它只授予本地主窗口，业务规则在 TypeScript 中。

## 仓库接口

入口是 `apps/desktop/src/core/repositories`，界面后续通过这里访问数据。生产环境调用 `initializeDataLayer()`，测试通过 `createDataLayer(database, { now, newId })` 注入数据库和时钟。

| 仓库        | 写入                                  | 查询与回收站                                                                              |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `memos`     | `create(input?)`、`update(id, patch)` | `list()`、`get(id)`、`softDelete(id)`、`listDeleted()`、`restore(id)`、`purgeContent(id)` |
| `events`    | `create(input)`、`update(id, patch)`  | 同上；删除、恢复和永久清空联动例外日程及关联提醒                                          |
| `reminders` | `create(input)`、`update(id, patch)`  | 同上；关联日程被删除时，必须先恢复日程                                                    |
| `settings`  | `setValue(key, json)`                 | `getValue(key)`，以及上述按记录 ID 操作的查询与回收站接口                                 |

所有新记录使用 UUID v7、Unix 毫秒时间和持久化设备标识。更新保留 `id`、`created_at`，更改 `updated_at`、`device_id`。默认查询排除已删除和已清空内容的记录。JSON 数组与布尔值在仓库边界转换；所有业务值使用绑定参数。

`deletion_group_id` 标识一次删除操作，恢复日程时只恢复同组记录，避免恢复之前独立删除的内容。`purged_at` 标识永久清空：保留 ID、创建时间、删除时间和墓碑，不再显示为可恢复内容，恢复会报错。活跃记录不能直接永久清空。设备标识设置不能修改或删除。

## 30 天清理

`trash.purgeExpired()` 只清空三类内容中 `deleted_at < now - 30 * 24h` 的记录；正好 30 天仍可恢复。清空内容、写入 `purged_at` 和设置 `last_trash_purge_at` 在同一事务内完成。已清空墓碑不重复更新。

启动时执行一次，运行期间每 24 小时执行一次。清理失败不记录成功时间；启动失败会拒绝初始化 Promise，后续可重试。没有物理 `DELETE`。

## 重复日程纯函数

`core/calendar/recurrence.ts` 的 `expandEvents(events, { start, end })` 返回与半开区间 `[start, end)` 重叠的实例，按开始时间排序。它处理每日、每周、每月、每年规则，支持 COUNT、UNTIL、EXDATE 和例外日程；移入查询范围的例外展示，移出范围的例外仍屏蔽原实例。传入的记录必须包含相关父系列和例外，不能只按例外原始时间筛选。

重复按日程自己的 IANA 时区展开，不依赖电脑时区。不存在的夏令时时间跳过且不占 COUNT；重复的当地时间选择较早的一次。全天日程保持当地日历边界。月底不存在的日期和非闰年的 2 月 29 日按 RRULE 跳过。

`editSeries(state, originalStart, scope, patch, context)` 与 `deleteSeries(...)` 返回 `{ created, updated }`，不执行数据库写入、不修改输入。`context` 显式传入 `now`、`deviceId`、`newId`，因此结果可重现；生产调用应传入新 UUID v7。`originalStart` 始终是原实例时间，即使例外已移动。

- `this`：修改生成或复用例外，并添加 EXDATE；删除添加 EXDATE 并软删除对应例外。
- `following`：旧系列 UNTIL 截断到目标之前；修改时创建新系列并保留剩余 COUNT，迁移仍符合新规则的未来例外，软删除不再匹配的例外；删除时移除目标及未来实例。
- `all`：修改原系列，时间平移时重新对应 EXDATE 和例外的 `original_start_at`，保留例外自身的内容与实际时间；删除软删除父系列和有效例外。

首个实例的 `following` 等价于 `all`。已有例外的实际内容在“全部”操作中保留；全部改变规则后，保留的不匹配例外仍可继续选择修改／删除范围。

日程页已在后续日程 PR 中接入：`events.editOccurrence(id, originalStart, scope, patch)`、`deleteOccurrence(...)` 调用上述纯函数并原子持久化。`create`、`update` 和实例操作同时同步 `source='event'` 的提醒；关闭提前提醒只软删除自动提醒，独立的手动提醒保持原状。通用事务语句可指定 `expectedRows`，快照过期或条件不匹配时整体回滚。详见 [日程联动与验证](calendar-verification.md)。

## 验证步骤（PowerShell）

在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm exec prettier . --check
pnpm --filter desktop tauri dev
```

1. 窗口应正常打开；按 F12 查看控制台，不应出现数据库初始化或迁移错误。
2. 在控制台执行 `const data = await (await import('/src/core/repositories/initialize.ts')).initializeDataLayer()`，再执行 `await data.settings.getValue('device_id')`，应得到 UUID；`await data.settings.getValue('last_trash_purge_at')` 应得到毫秒时间戳。
3. 关闭并重新运行开发应用，再读取设备标识，应与上次相同。首次启动产生的数据库可在上述应用数据目录找到；不要将它提交到 Git。
4. `pnpm test` 会在独立内存 SQLite 中验证 CRUD、联动恢复、回滚、30 天边界及三种重复日程操作，不修改实际应用数据库。
