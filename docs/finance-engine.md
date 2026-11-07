# 金融指标 Python 引擎（F1）验证说明

本 PR 仅实现 `engines/finance/`、规格文档与检查配置，不修改 `apps/`、`workbenches/`。sidecar 打包、Windows 凭据管理器、App 页面及提醒接入留到 F2–F4；AKShare 留到 F5。

## 环境与安装

本机已确认：uv 0.12.17、Python 3.12.14。Python 位于：

```text
C:\Users\royce\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe
```

无需重复安装 Python。普通 `python` 命令当前指向不可用的 Windows 商店别名，以下命令用 uv 选择 3.12，不依赖该别名。

在仓库根目录运行：

```powershell
uv sync --project engines/finance --locked --python 3.12
uv run --project engines/finance python -m finance_engine --version
```

依赖使用提交的 `uv.lock`，安装到 `engines/finance/.venv`。运行依赖仅有 httpx、pandas、numpy；开发依赖为 pytest、respx、ruff。没有 tushare、AKShare 或 PyInstaller（打包在 F2 添加）。

## 运行与密钥

先在你自己的 PowerShell 设置用户环境变量。下面的隐藏输入不会把 token 写入命令历史，也不会将它显示出来。**不要将 token 发送到对话。**

```powershell
$financeSecret = Read-Host '请输入 Tushare token' -AsSecureString
$financeCredential = [System.Net.NetworkCredential]::new('', $financeSecret)
[Environment]::SetEnvironmentVariable('TUSHARE_TOKEN', $financeCredential.Password, 'User')
Remove-Variable financeCredential, financeSecret
```

然后手动更新专用于金融数据的缓存。F1 使用仓库内被 Git 忽略的本地目录进行实测，正式应用目录在 F2 确认；不使用你的 `workbench.db`。

```powershell
$financeDb = Join-Path $PWD 'engines\finance\.local\finance.db'
$financeToken = [Environment]::GetEnvironmentVariable('TUSHARE_TOKEN', 'User')
@{ tushare_token = $financeToken; akshare_fallback = $false } |
  ConvertTo-Json -Compress |
  uv run --project engines/finance python -m finance_engine update --db $financeDb
Remove-Variable financeToken
```

token 只通过一行 stdin JSON 进入生产引擎，参数中没有 token。生产引擎不会读取环境变量；本地实测工具和 live 测试可以从本机环境取凭据。F1 接受备用源选项但不加载备用源。stdout 为 UTF-8 NDJSON；普通调试信息只能写 stderr。

其他命令：

```powershell
uv run --project engines/finance python -m finance_engine status --db $financeDb

$financeToken = [Environment]::GetEnvironmentVariable('TUSHARE_TOKEN', 'User')
@{ tushare_token = $financeToken } | ConvertTo-Json -Compress |
  uv run --project engines/finance python -m finance_engine verify --db $financeDb
Remove-Variable financeToken
```

`status` 不读取 token、不创建数据库，已有数据库严格以只读连接打开。`verify` 只请求 `trade_cal`、`adj_factor` 各一行，不读写缓存。

重建：将 `update` 加上 `--mode full-rebuild`，会清除指定金融缓存后重新下载，预计 35–50 分钟；这是明确的手动操作，请先确认路径。首次日历请求失败时不清除已有缓存。不要把此命令的 `--db` 指向用户数据库。

## 数据与计算约定

- 日历从 2005 年开始；个股日线和因子从 2015 年开始；三指数估值从 2005 年开始，实际覆盖以返回数据为准。
- 最新交易日按北京时间判断，个股当日 16:00、指数当日 19:00 才尝试；可用时间之后返回空数据记 pending，历史起点之前的指数无数据记 empty。
- 每次重拉最近三个交易日；行情和完成标记以每个交易日一个事务提交。Python 的 OS 文件锁同时保护命令行与 App 将来启动的引擎；异常退出自动释放锁，锁文件可以保留。
- `index` 阶段发布估值，`recent` 阶段完成最近 65 个交易日后发布最新两个个股指标，之后才回补历史。结果按 `(series_key, trade_date)` 存储，查询最新值取最大有效日期；缺依赖的 pending 不覆盖已有有效值。
- 60 日新高使用市场日历而非每只股票各自的 60 条行情。缺复权因子时保留日线并安排重试，受影响窗口不发布猜测值，不缩小分母。
- 估值的自然年窗口使用自然月偏移（5 年为 60 月，4.5 年为 54 月，10 年为 120 月，9 年为 108 月）；闰日截到目标月最后一天。分位包含当日，平值使用小于等于，原始 PE-TTM 无效时该日输出空值。
- 原始日线全部保留。`finance.db` 开启 WAL，结构由 Python 的 `meta.schema_version` 管理；未来升级只能增加迁移步骤，不改变已经发布的版本结构。
- 默认九条阈值只写入指标元数据，不在 F1 写 App 的阈值表或生成提醒。
- `done.new_dates` 只列出本次从未有有效结果变为有效结果的日期；重复重算不重新加入。新日期和上游错误也保存在 `run_log.summary_json`，供后续状态读取。
- 首次网络请求失败只记录 `run_log`，已有行情、指标、元数据及完成标记不变。

## 自动检查

在仓库根目录执行：

```powershell
uv run --project engines/finance --locked ruff check engines/finance
uv run --project engines/finance --locked ruff format --check engines/finance
uv run --project engines/finance --locked pytest engines/finance/tests
pnpm lint
pnpm typecheck
pnpm test
pnpm exec prettier . --check
```

如果沙盒临时目录不可写，可为本次测试指定一个新的、位于项目内的临时目录，例如：

```powershell
uv run --project engines/finance --locked pytest engines/finance/tests --basetemp engines/finance/.pytest_cache/manual-run
```

`--basetemp` 的目录会被 pytest 清理，仅能指向专用测试目录。

覆盖范围：前 5% 的 ceil、相同成交额、停牌和北交所；新高的复权、平高、上市时间、44/45 天、长期停牌和缺因子；估值不使用未来数据、三窗口起点、无效 PE 和手算分位；6000 行分页、has_more、分页失效回退、字段映射、限速、错误码、重试和脱敏；交易日与就绪时间；逐日事务回滚、文件锁、版本检查；断点续传结果哈希、提前发布、重算不产生新日期、重建隔离；CLI 和 NDJSON JSON Schema 合同。

CI 增加独立 Windows Python job，使用 Python 3.12、锁定 uv 依赖、ruff 和不联网 pytest，超时 5 分钟。现有 Windows job 增加 Prettier 检查；sidecar 打包和打包后 `--version` 在 F2 加入。

## 错误和退出码

| code                          | 含义及处理                                                             |
| ----------------------------- | ---------------------------------------------------------------------- |
| TOKEN_MISSING / TOKEN_INVALID | 缺少或无效 token，在本机重新设置；退出码 3                             |
| PERMISSION_DENIED             | 接口权限或积分不足，报告接口和上游原始 code/msg（脱敏）；退出码 3      |
| RATE_LIMITED                  | 等待 60 秒，最多重试三次；仍失败时退出码 4，或更新中的单日记失败后继续 |
| NETWORK                       | 网络/超时/5xx 按 2、8、30 秒重试；首个请求仍失败退出码 4               |
| DATA_NOT_READY                | 数据尚未发布或因子不完整，warning；整体 partial 退出码 0，下次再试     |
| UPSTREAM_SCHEMA               | 字段、分页或数据结构变化，拒绝写入不可信数据                           |
| DB_BUSY                       | 锁被另一更新进程持有，退出码 4                                         |
| DB_ERROR                      | 无法访问、损坏或版本不兼容，退出码 1；检查路径或重建                   |
| INTERNAL                      | 程序异常，退出码 1；提供脱敏后的错误和运行记录                         |
| ARGUMENT                      | 命令、路径或参数格式错误，退出码 2                                     |

退出码 0 可能是 ok 或 partial，务必同时检查最后一条 `done.status`。所有上游 msg 写入运行记录前再次脱敏；真实密钥不会出现在参数或报告中。

## 手动验收步骤

1. 执行环境和自动检查命令，确认 `--version` 返回 hello JSON，全部自动检查通过。
2. 不提供 stdin 运行 `update`，应返回 TOKEN_MISSING；不应开始取数。
3. 按本节设置 token，运行 `verify`；应返回 done/ok，且不创建或修改缓存。
4. 首次运行 update，观察 calendar → stock_basic → index → recent → backfill → compute。应在 backfill 结束前看到最新指标的 indicator_updated 事件。
5. 在 backfill 中按 Ctrl+C，再执行同一 update。已成功的历史天数应跳过（最近三日会按规定重新拉取）；最后结果应无重复记录。
6. 再运行一次 update，检查 run_log 调用量。没有新缺口时正常应不超过 20 次，`done.new_dates` 为空。
7. 19:00 前运行时，指数数据应截至上一交易日；周末不应请求不存在的未来交易日。
8. 断网运行，等待有限重试后应出现 NETWORK。行情、指标和完成标记保持原样，只有 run_log 增加失败记录。
9. 同时启动两个 update，第二个应返回 DB_BUSY，不应并行写入。
10. 在单独测试缓存运行 full-rebuild，结果应可再生，用户的 workbench.db 不受影响。

## 联网实测与记录

**当前状态：等待 Royce 在本机设置 TUSHARE_TOKEN，尚未进行真实取数。以下待测项不得视为已通过。**

联网对照测试（默认被 pytest 和 CI 排除）：

```powershell
$env:TUSHARE_TOKEN = [Environment]::GetEnvironmentVariable('TUSHARE_TOKEN', 'User')
uv run --project engines/finance --locked pytest engines/finance/tests -m live -q
Remove-Item Env:TUSHARE_TOKEN
```

完整测量工具：

```powershell
$env:TUSHARE_TOKEN = [Environment]::GetEnvironmentVariable('TUSHARE_TOKEN', 'User')
uv run --project engines/finance --locked python engines/finance/scripts/live_validation.py --db $financeDb --probe-rate-limit
Remove-Item Env:TUSHARE_TOKEN
```

工具检查 limit/offset 与完整响应的切片是否一致，以一行受限接口请求观察权限错误；`--probe-rate-limit` 仅在实测工具中最多发出 51 次 stock_basic 小请求，观察其 50 次/分钟限制，随后等待 65 秒释放配额。生产客户端始终按全局 180 次/分钟、stock_basic 45 次/分钟限速。上游原始 code/msg 写进 probe 的 run_log；没有实际观察到的错误不会编造错误码。

工具随后正常更新，并报告实际数据库大小、耗时、各接口调用次数、指数覆盖起点、60 日新高 P5/P50/P95 和独立手算的三个交易日。`--probe-only` 可以只测接口而不回补历史。

| 项目                              | 结果                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| daily limit/offset 是否生效       | 待联网实测                                                                                     |
| 积分不足 code/msg                 | 待联网实测                                                                                     |
| 限流 code/msg                     | 待联网实测                                                                                     |
| 2026-11-05 前5%占比、N、k         | 待实测；规格对照 44.2%、5217、261                                                              |
| 2026-11-05 沪深300 PE-TTM / PB    | 待实测；规格对照 13.59 / 1.34                                                                  |
| 三指数估值实际起点与首次调用次数  | 待联网实测                                                                                     |
| 首次完整回补耗时、finance.db 体积 | 待联网实测                                                                                     |
| 新高占比 P5 / P50 / P95           | 待首次完整回补，不据此擅自调整默认阈值                                                         |
| 三个交易日独立手算新高占比        | 待完整回补                                                                                     |
| Python CI 时长预算                | 首次通过的独立 job 用时 46 秒，低于 5 分钟；同轮 Windows CI（含桌面编译）用时 5 分 27 秒并通过 |

本地记录（2026-11-07）：Python 自动测试 28 项通过，1 项 live 默认排除；现有 Vitest 143 项通过；pnpm lint、typecheck、Prettier、ruff check 和 ruff format --check 通过。[首次完整通过的 CI](https://github.com/roycelee597/WorkBench/actions/runs/42314768673) 已验证 Windows 桌面编译；后续注册表扩展测试随最终提交再次运行 CI。联网结果仍等待本机 token，不记为通过。

参考：[uv 官方 GitHub Actions 指南](https://docs.astral.sh/uv/guides/integration/github/)、[Tushare 日线接口](https://tushare.pro/document/2?doc_id=27)、[权限负例接口 kpl_list](https://tushare.pro/document/2?doc_id=347)。官方日线页没有列出 offset/limit，因此以实际分页探针结果为准。
