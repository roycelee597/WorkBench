# 金融模块升级、卸载和重装验收

P0-2 从安装包的 `official/finance.wbpkg` 加载金融模块。包内含静态前端和单并发引擎，安装及每次启动前校验 SHA-256。自动更新、测试连接和停止更新由通用引擎运行时管理。正式默认构建沿用不含 AKShare 的引擎。

升级继续使用原有的金融缓存、主库和系统凭据服务。安装失败时可以在模块管理重试，旧数据在原处。卸载会清除已安装包、引擎运行目录和日志、金融数据库、设置、阈值、提醒游标、跳转索引及 Tushare 凭据。金融提醒在共享表中只保留用于同步的空墓碑，金融专用表保留空结构供重装使用。

## Windows 手动验收

1. 在仓库根目录安装锁定依赖，执行下面的命令生成专用 identifier、数据目录和旧版合成数据。换一个未使用过的后缀可以复测。全部使用虚构凭据，出现首次回补弹窗时点「稍后」。

   ```powershell
   pnpm install --frozen-lockfile
   uv run --project engines/finance --locked python engines/finance/scripts/prepare_module_check.py manual01
   $financeCheckConfig = (Resolve-Path 'dist/finance-module-check-manual01/tauri.json').Path
   ```

2. 用上一个版本（`a1f1419`）的独立检出构建旧版安装包。在旧版仓库根目录先运行 `pnpm install --frozen-lockfile` 和 `pnpm finance:engine`，然后在同一 PowerShell 用 `pnpm --filter desktop tauri build --bundles nsis --config $financeCheckConfig` 覆盖标识、产品名和数据目录。安装到单独目录，启动后确认窗口标题含 `manual01`。金融页应见 43.3% 和「P0-2 旧版阈值」，可在综合工作台新增一条合成备忘。确认后从托盘退出旧版。
3. 回到新版仓库根目录，运行 `pnpm finance:package`，再用同一个 `$financeCheckConfig` 执行 `pnpm --filter desktop tauri build --bundles nsis --config $financeCheckConfig`。把新版装到刚才的隔离安装目录。打开后从托盘退出再启动一次，核对金融自动安装且只有一个入口，原行情、阈值和备忘仍在。在「设置 → 模块管理 → 金融设置」核对 token 仍为已设置，尾号为 `Q4PL`。保留原图表偏好。
4. 到「设置 → 模块管理」，点击金融模块的「卸载」，核对确认框列出的引擎、行情库、阈值、提醒状态、设置及凭据。确认后检查隔离目录中应用数据下的 `app/modules/com.royce.workbench.finance/` 和 `app/finance.db` 均不存在。Windows 凭据管理器中只检查服务名含 `p02-check-manual01.finance` 的测试凭据已消失。重启后金融入口不自动恢复，「综合工作台」和「AI 助手」仍可打开。
5. 点击「安装官方金融模块」。金融入口应恢复，首次打开要求设置 Tushare token，没有旧行情、旧阈值或自定义图表设置。用隔离数据复核时保持回补未确认。

## 开发验收页

验收页可验证实际 Tauri IPC 及 SQLite 生命周期。每次运行需要新的合成夹具，完成后保留重装状态。

```powershell
uv run --project engines/finance --locked python engines/finance/scripts/prepare_module_check.py native01
$financeNativeConfig = 'dist/finance-module-check-native01/tauri.json'
$financeNative = Get-Content -LiteralPath $financeNativeConfig -Raw | ConvertFrom-Json -AsHashtable
$financeNative.app.windows[0].url = 'tests/finance-module-native.html'
$financeNative | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $financeNativeConfig -Encoding utf8
pnpm --filter desktop tauri dev --config ../../dist/finance-module-check-native01/tauri.json
```

验收页只接受合成夹具的 identifier。预期出现 13 条「通过」和「完成」，包含旧行情、阈值、评估游标、设置及凭据保留，重复初始化，原生卸载、主库清理及离线重装。

## 自动检查与实测

- Python 包测试核对 manifest 的摘要、前端入口及引擎与包内实际字节一致，并用 Windows CI 的 CP1252 重定向条件检查打包报告仍以 UTF-8 输出。
- Rust 测试覆盖首次迁移中途失败后恢复、同一安装重复接管、隔离凭据保留及卸载、清理失败后重试、本地重装、摘要被篡改后拒绝通过、进度和错误诊断传递、脱敏、强制结束及停止整个 Windows Job 进程树。
- Vitest 覆盖卸载时已执行事务排空而排队写入拒绝、主库 SQL 清理失败回滚、保留综合与 AI 状态、离线 SDK 权限边界与错误码、金融未装时 AI 正常及金融引用提示。
- 隔离 Windows 发行版实测自动安装、首次回补确认以及沙盒中读取旧行情和阈值。旧行情文件前后 SHA-256 一致。独立的开发验收页经真实 IPC 演练升级、卸载及重装，13 项全通过。
- Windows NSIS 安装包构建通过，解包核对 `official/finance.wbpkg` 与构建产物的 SHA-256 完全一致。发行版验收使用独立的可执行文件，以合成数据模拟旧版状态。
- 另用全空白的隔离凭据启动实际打包引擎的「测试连接」，确认 Python 在发出请求前拒绝输入。Tauri 收到 `TOKEN_MISSING` 及对应文案。
- 本地 lint、类型检查和 Prettier 通过，522 项 Vitest、54 项 Rust 和 110 项金融 Python 测试通过。需要真实行情的 Python 用例按离线设置跳过。
- 实测均使用独立 identifier、独立数据目录和虚构凭据。未发起行情请求，也没有操作正式安装版的数据。
