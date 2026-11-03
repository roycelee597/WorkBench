# 参与 WorkBench 开发

开始前请先阅读 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [AGENTS.md](AGENTS.md)。
设计与范围以架构文档为准，以下流程对应其第 9.2 节。

## 分支规范

- `main` 始终保持可运行，不直接在 `main` 上开发。
- 每项任务使用独立分支，按用途使用 `feat/`、`fix/`、`docs/`、`chore/` 前缀。
- 示例：`feat/memo-editor`、`fix/reminder-repeat`、`docs/readme`、`chore/scaffold`。

```powershell
git switch main
git pull --ff-only
git switch -c feat/memo-editor
```

## 提交规范

使用 Conventional Commits，格式为 `类型(可选范围): 中文说明`，按可以单独理解的改动小步提交。

| 类型       | 用途           | 示例                                   |
| ---------- | -------------- | -------------------------------------- |
| `feat`     | 新功能         | `feat(memos): 支持置顶`                |
| `fix`      | 修复问题       | `fix(reminders): 修复重复提醒重复弹出` |
| `docs`     | 文档           | `docs: 补充 Windows 开发步骤`          |
| `refactor` | 重构           | `refactor(sdk): 整理消息类型`          |
| `test`     | 测试           | `test(manifest): 覆盖未知权限`         |
| `chore`    | 工具和仓库维护 | `chore: 初始化 monorepo`               |
| `ci`       | 持续集成       | `ci: 添加 Windows 构建检查`            |

提交前检查 diff 并本地运行验证。不提交密钥、`.env`、数据库文件、依赖目录或构建产物；遵守现有 `.gitignore`。
不强制推送，不改写已推送的历史。

## 本地验证

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

新增逻辑应有单元测试，尤其是数据仓库、调度器和权限判断。当前骨架阶段允许空测试集。

涉及桌面端时，还应运行以下命令，确认窗口和本次修改的行为正常，并在 PR 中写明手动测试步骤：

```powershell
pnpm --filter desktop tauri build --no-bundle
pnpm --filter desktop tauri dev
```

代码和文档使用 UTF-8、LF 换行；运行 `pnpm format` 格式化后再次检查 diff。

## Pull Request 流程

```powershell
git add <本次改动的文件>
git commit -m "feat(memos): 新增备忘录编辑器"
git push -u origin feat/memo-editor
gh pr create --base main
```

1. PR 说明改了什么、为何修改、如何验证；界面变更附上截图。
2. 等待 CI 全部通过，再自行检查一次 diff。
3. 使用 **Squash and merge** 合入 `main`，之后删除功能分支。
4. 每个阶段完成后，按语义化版本打标签（如 `v0.1.0`），并更新 `CHANGELOG.md`。

本任务只搭建 Phase 0 骨架；后续功能按架构文档分阶段实现。
