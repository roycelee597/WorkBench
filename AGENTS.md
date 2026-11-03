# AGENTS.md · 给 Codex 的规则

**开始任何任务前，先读 `ARCHITECTURE.md`。** 它是本项目的唯一设计依据；如与本文件冲突，以 ARCHITECTURE.md 为准，并提醒用户。

## 关于用户
- 用户是编程初学者：请用**中文**解释你做了什么、为什么、怎么验证。
- 每次只做被要求的那一件事，不擅自加功能、不擅自换技术栈或依赖。
- 需要用户手动安装/操作/付费的事情，停下来列出清晰步骤。

## 技术栈（不要更换）
Tauri 2 · React + TypeScript（strict）· Vite · pnpm workspaces · Tailwind + shadcn/ui · Zustand · SQLite（tauri-plugin-sql）· Vitest · ESLint + Prettier。

## 代码规则
- TypeScript 严格模式，禁止 `any`（确需时写注释说明）。
- 业务逻辑写在 TypeScript；Rust 只做系统能力（托盘、通知、文件、插件安装、自定义协议）。
- 数据库：只通过 `apps/desktop/src/core/repositories` 访问；改表只能新增迁移文件；每条记录必须有 `id`(UUID v7)、`created_at`、`updated_at`、`deleted_at`、`device_id`；**只软删除**。
- 分工作台只能使用 `@workbench/sdk`，不得直接调用 Tauri API 或数据库；Bridge 必须检查权限并用 zod 校验参数。
- iframe 沙盒禁止 `allow-same-origin`；`wbpkg://` 协议要防路径穿越。
- 文件/组件命名：组件 `PascalCase.tsx`，其他 `kebab-case.ts`；代码注释与界面文案用中文。
- 新逻辑要配单元测试（尤其仓库、调度器、权限）。

## 完成前必须
1. `pnpm lint`、`pnpm typecheck`、`pnpm test` 全部通过。
2. 涉及桌面端时确认 `pnpm --filter desktop tauri dev` 能运行。
3. 给出用户可以照做的手动测试步骤。

## Git
- 不在 `main` 上直接开发；分支名 `feat/…`、`fix/…`、`docs/…`、`chore/…`。
- 提交信息用 Conventional Commits（可用中文描述）：`feat(memos): 支持置顶`。
- 小步提交；不要提交密钥、`.env`、数据库文件、构建产物（见 `.gitignore`）。
- 不要强制推送（force push）、不要改写已推送的历史。
