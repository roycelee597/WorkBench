# AKShare 可选备用源

## 打包决定（2026-11-13）

Royce 已根据 F5 第 1 步的实测结果选择：**正式版默认不打包 AKShare，仅保留可选能力**。

`akshare` extra 锁定为 [AKShare 1.20.35](https://pypi.org/project/akshare/1.20.35/)，与规格核对接口时的版本一致。默认的 `pnpm finance:engine` 和 `pnpm build` 命令不启用 extra，打包脚本默认排除 AKShare。只有显式安装 extra 并传入 `--with-akshare` 才会把它放进 sidecar。

## Windows x64 体积与启动实测

| 项目                   |               不含 AKShare |               包含 AKShare |                增量 |
| ---------------------- | -------------------------: | -------------------------: | ------------------: |
| sidecar exe            | 37149194 字节（35.43 MiB） | 62717384 字节（59.81 MiB） |           24.38 MiB |
| NSIS 安装包            | 39984724 字节（38.13 MiB） | 65409222 字节（62.38 MiB） | 24.25 MiB，约 63.6% |
| `--version` 启动中位数 |                   2.089 秒 |                   2.592 秒 |            0.503 秒 |
| 七次启动的最小／最大值 |            2.069／2.112 秒 |            2.580／2.593 秒 |                   — |

测量环境：Windows 11 x64、Python 3.12.14、uv 0.12.17、PyInstaller 6.22.3、PyInstaller hooks 2026.9、AKShare 1.20.35、mini-racer 0.14.1。两个独立虚拟环境使用同一锁文件和相同默认依赖组，只有 AKShare 及其依赖不同。

- 主程序从包含 F1–F4 的 main 构建一次，两个安装包使用同一主程序和同一配置。两次打包后主程序 SHA-256 相同，为 `e53177c949691e6850fc49e35ce37720439c64dc0fe31bfdfE7c47383022b5df`（比较时忽略大小写）。
- 测量标识为 `com.royce.workbench.f5-size-check`，安装包使用单独名称，没有覆盖正式版安装包。仅构建和打包，没有安装或启动该工作台。
- 每种 sidecar 先预热一次，再交替测量七次；计时涵盖启动进程、PyInstaller 解压、输出版本事件和进程退出。它不是清空操作系统缓存后的冷启动，也不代表主窗口启动或联网取数时间。
- 每次版本调用只有 `--version`，没有 token、stdin 凭据、数据库参数或联网更新；使用独立临时目录，进程结束后临时目录为空。
- PyInstaller 只收集 `akshare` 时会漏掉新浪接口需要的 V8 DLL 与 ICU 数据。最终包含版本显式收集 `akshare` 和 `py_mini_racer`，并检查归档内确有 `mini_racer.dll`、`icudtl.dat`；默认版本归档没有 AKShare。
- 两个 NSIS 包均通过 7-Zip 完整性检查。解出包内 `finance-engine.exe` 后，其哈希分别与对应测量 sidecar 一致。测量完成后，工作区原默认 sidecar 已按哈希确认恢复。

原始测量结果和安装包保存在本机 Git 忽略目录 `engines/finance/dist/f5-package-size/`，包括 `bundle-results.json`、`startup-results.json`、`restore-result.json` 及两个变体目录。临时测量虚拟环境已清理，避免项目检查扫描第三方 JavaScript。构建产物与虚拟环境不提交。

## 显式可选打包

以下命令在仓库根目录执行，只生成可选 sidecar；不运行取数、不打开数据库：

```powershell
$financeOptionalRoot = Join-Path (Get-Location) 'engines/finance/dist/optional-akshare'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $financeOptionalRoot '.venv'
uv sync --project engines/finance --locked --group build --extra akshare
uv run --project engines/finance --locked --group build --extra akshare python engines/finance/scripts/build_sidecar.py --with-akshare --dist-dir "$financeOptionalRoot/bin" --work-dir "$financeOptionalRoot/build"
Remove-Item Env:UV_PROJECT_ENVIRONMENT
```

默认打包保持原命令，无需更改：

```powershell
pnpm finance:engine
```

## 备用范围

规格仅允许以下同口径数据作为备用：交易日历、沪深300 收盘、目标日为今天的全市场成交额快照（过滤北交所，仅用于前 5% 指标）。创业板指和上证指数估值、沪深300估值及历史个股日线均不使用 AKShare 替代，避免把不同口径混入历史序列。
