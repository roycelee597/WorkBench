# PR #38 后续待办

基准 main：`a1f14192c9b128f33a742f6c44555b251ef167c4`。

- [ ] P0-2 金融迁移：`engine.*` 透传符合 `[A-Z_]{1,40}` 的白名单错误码，以及 `current` 进度字段。
- [ ] 在插件指南注明 `uninstall.tables` 和 `uninstall.settingsPrefixes` 仅为声明。
- [ ] 卸载期间拦截模块已排队的写入。
- [ ] 在隔离实例手动验证模块 iframe 无法调用 Tauri IPC。确认 `__TAURI_INTERNALS__`、`window.ipc` 和 `fetch('http://ipc.localhost')` 都不可用。
- [ ] P0-3 AI 迁移：用户通过 AI 创建的记录归用户所有，避免把来源标成 AI 模块 ID，确保卸载 AI 时保留这些记录。
