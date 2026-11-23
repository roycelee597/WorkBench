# PR #38 后续待办

基准 main：`a1f14192c9b128f33a742f6c44555b251ef167c4`。

- [x] P0-2 金融迁移：`engine.*` 透传符合 `[A-Z_]{1,40}` 的白名单错误码，以及 `current` 进度字段。
- [x] 在插件指南注明 `uninstall.tables` 和 `uninstall.settingsPrefixes` 仅为声明。
- [x] 卸载期间拦截模块已排队的写入。
- [ ] 在隔离实例手动验证模块 iframe 无法调用 Tauri IPC。确认 `__TAURI_INTERNALS__`、`window.ipc` 和 `fetch('http://ipc.localhost')` 都不可用。

## PR #39 后续待办

- [ ] 编译期将附带的 `finance.wbpkg` 的 SHA-256 写入主程序，由 `ensure_official` 在安装前核对，增加一层校验。
- [ ] 在 manifest 说明或插件指南注明，`uninstall.credentials` 中的 `tushare/tushare` 声明实际不会清除 Tushare token。真实 token 沿用旧服务名，卸载时由宿主单独删除。
- [ ] 设计同步时处理 `finance_thresholds` 和 `workbench_kv` 的卸载语义。当前卸载会硬删除金融记录，不保留墓碑。
- [ ] 禁止金融模块直接调用通用 `engine.start`，仅允许通过 `finance.requestUpdate` 和 `finance.verify` 启动，避免绕过首次回补确认。
- [ ] 在隔离实例升级后，检查安装目录是否残留旧的 `finance-engine-*.exe`。
