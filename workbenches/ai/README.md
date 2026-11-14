# AI 助手

A1 仅提供设置分区：系统凭据、测试连接、模型与今日用量。所有数据调用集中在 `src/api.ts`，业务设置经 core 仓库访问；DeepSeek 网络请求和用量文件由 Rust 管理。

对话页、快捷键、操作登记、确认卡片和对话记录分别留到 A2–A5。规格见 `docs/specs/ai-assistant.md`，隔离验收步骤见 `docs/ai-client-verification.md`。
