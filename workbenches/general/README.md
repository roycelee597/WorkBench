# 综合工作台

Phase 1 内置工作台：四个页签默认打开今天，已实现备忘录编辑、标签与搜索、主题设置和备忘录回收站。今天、日程、提醒事项目前为占位页。

所有数据调用集中在 src/api.ts，经已有 core 仓库访问；Phase 2 在此替换为 @workbench/sdk。其他组件、状态和编辑器不直接访问 Tauri API 或数据库。正文使用 Tiptap 所见即所得编辑，并以 Markdown 保存。

在根目录运行 pnpm --filter @workbench/general typecheck 可检查本包类型，pnpm test 包含 Markdown 往返、接口与自动保存测试。手动步骤和截图见 [备忘录验证说明](../../docs/memos-verification.md)。
