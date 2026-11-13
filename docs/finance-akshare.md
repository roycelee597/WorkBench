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

备用源只在主源失败且开关开启时懒加载。未安装组件时静默跳过，不另报“缺少 AKShare”；Tushare 本身的失败仍正常显示。设置里的“测试连接”始终只验证 Tushare，不会用备用源冒充连接成功。取消更新不会触发备用取数。

- 交易日历从 2005 年开始，只写新浪实际返回的开市日；不会把接口没有返回的日期猜成休市，也不删除已有交易所日历。来源保存在现有 `dataset_status.source`，不修改缓存表结构。
- 沪深300 收盘使用 `stock_zh_index_daily("sh000300")`，数据写入 `index_daily.source='akshare'`。历史收盘可以备用，当天收盘仍受北京时间 19:00 就绪规则限制。已有的有效 Tushare 收盘优先保留；主源恢复后可以覆盖备用值。
- 成交额快照使用 `stock_zh_a_spot_em()`，仅保留代码以 0／3／6 开头的沪深 A 股，成交额由元换算为千元，沿用 `ceil(N×5%)` 和成交额为正的口径。符合条件的行存在非有限数或重复代码时拒绝整份快照，不能悄悄缩小分母。只写前 5% 指标，`extra_json.source='akshare'`；不伪造个股日线、复权因子或估值。有效主源指标优先保留。
- 快照必须对应**实际北京时间的今天且已过 16:00**，抓取跨午夜时丢弃。`--now` 只影响规划和重试，不会把实际今日快照冒充历史数据。没有同口径备用的项目继续保留缓存并显示未就绪。
- 双源均失败时保留已有行情和指标；首个日历请求在双源均不可用时仍只写 `run_log`。日历备用成功表示已获得有效数据，之后可以发布白名单备用结果，整次更新标为“部分完成”。
- 菱形和悬浮提示标出备用点，沪深300 叠加线也适用。月均只要包含有效备用日值，就标为“月均含 AKShare 备用源”。关闭开关只影响后续取数，不抹除缓存来源。

## 使用与手动核对

普通正式版无需安装新依赖，继续使用 Tushare。开关默认开启，但默认包没有 AKShare，会自动跳过。勾选开关不会下载或安装组件。

需要自行构建可选版时：

1. 按上面的 PowerShell 命令生成可选 sidecar。在应用退出且没有引擎运行时，将可选产物复制到 `apps/desktop/src-tauri/binaries/finance-engine-x86_64-pc-windows-msvc.exe`。
2. 用 `pnpm --filter desktop tauri build` 打包。不要用根目录 `pnpm build`，它会先重新构建默认的不含 AKShare 的 sidecar。
3. 用独立 identifier 和 `app.appDirectoriesOverride` 配置隔离实例做验收，数据目录必须独立；不要拿正式缓存测试故障、重建或开关持久化。
4. 打开设置 → 金融指标，确认开关默认勾选；关闭后重启，确认仍关闭。重新勾选后，只有 Tushare 失败时才会尝试三个白名单入口。
5. 用隔离合成库给前 5% 日值和沪深300 收盘标记 `source=akshare`，进入金融页：确认菱形和来源说明；切到月均，确认含备用日值的月均仍有标记。未标记的普通缓存保持原样。
6. 如需恢复默认构建，运行 `pnpm finance:engine`。不要把 exe、缓存数据库或任何真实 token 提交到 Git。

以上是开发者自选流程，本次没有要求 Royce 安装组件、填写 token 或重新回补。可选版三方接口的实时可用性未用真实请求验收；故障切换、数据口径及禁用入口均由离线测试验证。

## F5 自动检查与隔离实测（2026-11-13）

自动检查命令：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm exec prettier . --check
uv run --project engines/finance --locked ruff check engines/finance
uv run --project engines/finance --locked ruff format --check engines/finance
uv run --project engines/finance --locked pytest engines/finance/tests
```

离线单测覆盖主源失败后的备用切换、禁用／未安装组件时缓存不变、取消不取备用、主源成功不导入组件、源码范围白名单、今日快照日期及就绪时间、北交所过滤、异常分母拒绝、缓存来源优先级、月均与叠加线标记，以及设置持久化与保存失败。ECharts SVG 渲染测试确认主指标和叠加线的备用菱形实际可见。

Windows 实测使用 `com.royce.workbench.f5-native-check` 和独立目录 `engines/finance/dist/f5-runtime/app/`，合成三天数据、独立虚构凭据，不使用真实 token，也没有运行正式引擎回补。发行版通过 `tauri build --no-bundle --config ...` 构建，未启动 `tauri dev`。

- 冻结依赖探针使用正式可选打包的相同 PyInstaller 收集参数；AKShare 版本为 1.20.35，三个白名单函数可导入，`MiniRacer.eval("1+1")` 返回 2。这验证可选组件及 V8 DLL／ICU 能运行，不代表真实联网接口已成功。
- 原生界面验收使用另一个仅在 Git 忽略目录中的离线协议入口，检查数据库参数严格指向隔离目录；只记录 `akshare_fallback`、模式和时间，不记录凭据。此入口用于检查 React → Rust → stdin 和显示状态，实际取数及计算逻辑由上述 Python 测试覆盖。
- 日线主指标和沪深300 收盘都显示了备用菱形；切到月均后保留菱形、来源说明和“本月至今”。[隔离月均截图](screenshots/finance-akshare-monthly.jpg)。
- 默认开启时原生入口收到 `true`；界面关闭后收到 `false`，隔离业务库中 `finance.akshare_fallback` 为 JSON `false`。失败状态下缓存仍可查看，来源说明仍保留。
- 停止闲置隔离进程后重新启动，设置仍未勾选；启动自动更新再次收到 `false`。[重启后设置截图](screenshots/finance-akshare-settings.jpg)。重新开启后收到 `true`，离线夹具返回的 `partial` 正常显示为“部分数据待补齐”。正式版进程保持运行，未对其数据库、阈值或凭据进行写入。验收后仅停止闲置隔离实例、清理本次虚构凭据，保留隔离记录。

本地结果：`pnpm lint`、`pnpm typecheck`、`pnpm test`（193 项）、`prettier . --check`、`ruff check`、`ruff format --check`、`pytest`（85 项，真实取数测试默认排除）均通过。Python 默认环境和安装 AKShare extra 的独立环境分别运行离线测试。最终默认 `pnpm finance:engine` 成功，版本事件 `with_akshare=false`，归档中没有 AKShare；最终 sidecar 为 37158667 字节（实现功能后略大于前述同条件体积对比时的版本）。

## 提交复审前待确认

已向 Royce 询问：`TOKEN_INVALID`、`PERMISSION_DENIED` 是否也触发三个白名单备用入口。F5 文本只写“Tushare 失败”，§11 同时要求凭据／积分错误清楚显示。当前草稿按一般失败处理，并保留主源诊断；建议配置错误直接报告并引导设置，仅对网络、限流和上游字段故障启用备用。收到答复后补充相应回归，再将草稿提交复审；“测试连接”在两种方案中均只验证 Tushare。
