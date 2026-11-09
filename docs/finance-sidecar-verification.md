# 金融指标工作台 F2 验证

金融缓存位于 `%LOCALAPPDATA%\com.royce.workbench\finance.db`。在 Windows 的隔离 Tauri 实例中，SQL 插件通过绝对路径读取该基目录下的测试缓存成功，写入探测被 SQLite 的 `mode=ro` 拒绝。前端查询后只关闭金融连接池，综合工作台的连接可继续使用。

## 开发和检查

在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm finance:engine
pnpm --filter desktop tauri dev
```

打包命令使用锁定的 PyInstaller 生成 Windows x64 单文件，并运行 `--version`。要调试 Python 源码，先完成一次打包，再在同一 PowerShell 会话中执行：

```powershell
$env:WORKBENCH_FINANCE_ENGINE_DEV = '1'
try {
  pnpm --filter desktop tauri dev
} finally {
  Remove-Item Env:WORKBENCH_FINANCE_ENGINE_DEV -ErrorAction SilentlyContinue
}
```

正常安装包构建使用 `pnpm build`。单独构建 NSIS 可先运行 `pnpm finance:engine`，再运行 `pnpm --filter desktop tauri build --bundles nsis`。

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm exec prettier . --check
uv run --project engines/finance --locked ruff check engines/finance
uv run --project engines/finance --locked ruff format --check engines/finance
uv run --project engines/finance --locked pytest engines/finance/tests
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib finance::tests
```

## 手动验收

### 1. 凭据和测试连接

1. 打开设置，滚动到「金融指标」。在密码框输入 Tushare token，点「保存」。首次弹窗可先选「稍后」，以便测试连接。
2. 保存后应只显示末四位。点「测试连接」应显示连接和积分检查结果。使用测试用的无效 token 时，应出现 token 无效。
3. 从 Windows 开始菜单搜索「凭据管理器」，进入「Windows 凭据」。查看包含 `com.royce.workbench.finance` 的普通凭据，账户为 tushare。
4. 在一次更新运行期间打开任务管理器的「详细信息」。右键列头，在「选择列」中勾选「命令行」。找到 `finance-engine.exe`。参数包含 update、数据库路径及模式，命令行中应搜不到 token。
5. 更新停止后点「清除」。确认尾号和凭据管理器中的对应条目消失。

### 2. 首次回补和恢复

1. 在空缓存中保存有效 token，点「开始」。进入「金融指标」，观察日历、证券目录、指数、近期行情、历史和计算阶段。历史阶段会显示进度与预计剩余时间，近期行情计算后应能看到最新数据日期。
2. 点击窗口关闭按钮后从托盘打开。更新应仍在同一进度上运行。通过托盘「退出」结束进程后再启动，已完成的历史日应跳过，保留最近三日刷新规则。
3. 在设置里点「重建金融数据」。确认对话框出现后可先取消。确认后会重新构建本地行情缓存，可用专门的测试缓存验证。

### 3. 增量、后台启动与手动更新

1. 完成回补后退出 App，再启动。等待约 10 秒，应自动开始增量更新。也可使用 `--background` 启动并从托盘打开查看状态。
2. 同一进程里反复进入金融页或从托盘打开，不应出现新的更新。点击「立即更新」可主动启动，更新期间按钮显示「更新中…」。
3. 在没有历史缺口的情况下检查 `finance.db` 的 `run_log.summary_json` 中 calls 合计，通常不超过 20 次。19:00 前仍按引擎就绪规则刷新指数估值。

### 8. 离线

1. 有本地缓存时断网，打开 App 或点击「立即更新」。之前的数据截至日期仍可读。
2. 有限重试结束后，状态栏应显示网络错误。重新联网后可点击「立即更新」继续补取。

## 本机实测

- tauri dev 在隔离标识 `com.royce.workbench.finance-f2-check` 下运行。本地测试缓存用于验证绝对路径、只读限制、设置页数据状态和综合工作台连接仍可用。
- 临时无效凭据用于验证 Windows 凭据管理器条目、尾号、清除、首次回补弹窗和 `TOKEN_INVALID`。分别使用 uv 开发模式和打包后的 sidecar 发起更新，金融页都收到引擎错误并退出运行态。快速新建窗口的凭据访问被拒绝。
- Rust 单测检查 sidecar 参数不含凭据。前端用模拟 IPC 测试事件解析、重复启动、更新完成与失败、取消、只关闭金融连接池以及启动定时器。
- 旧版缺码和缺因子 error 的恢复使用真实 CLI 入口配合模拟 Tushare 响应验证。`--now` 固定用于计数的时间。真实账号的完整回补和断网恢复可按上面的步骤验收。

### Windows x64 体积

在同一个 release 主程序上构建两次未签名的 NSIS 安装包。对照包通过 `tauri bundle --config` 将 `bundle.externalBin` 设为空，差值反映 sidecar 对安装包的影响。

| 产物                       |     字节 |   MiB |
| -------------------------- | -------: | ----: |
| PyInstaller 单文件 sidecar | 37145310 | 35.42 |
| NSIS 对照包                |  3245836 |  3.10 |
| NSIS 含 sidecar            | 39773808 | 37.93 |
| NSIS 增量                  | 36527972 | 34.84 |
