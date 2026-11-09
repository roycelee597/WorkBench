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

先在仓库根目录打开 PowerShell，粘贴下面的函数。运行所需的命令块时会提示隐藏输入。`TUSHARE_TOKEN` 只在当前 PowerShell 会话中设置，每个命令块用 `finally` 清理。**不要将 token 发送到对话。**

```powershell
function Set-TushareSessionToken {
  $financeSecret = Read-Host '请输入 Tushare token' -AsSecureString
  try {
    $env:TUSHARE_TOKEN = [System.Net.NetworkCredential]::new('', $financeSecret).Password
  } finally {
    $financeSecret.Dispose()
  }
}
```

然后手动更新专用于金融数据的缓存。F1 使用仓库内被 Git 忽略的本地目录进行实测，正式应用目录在 F2 确认；不使用你的 `workbench.db`。

```powershell
$financeDb = Join-Path $PWD 'engines\finance\.local\benchmark\finance.db'
try {
  Set-TushareSessionToken
  @{ tushare_token = $env:TUSHARE_TOKEN; akshare_fallback = $false } |
    ConvertTo-Json -Compress |
    uv run --project engines/finance python -m finance_engine update --db $financeDb
} finally {
  Remove-Item Env:TUSHARE_TOKEN -ErrorAction SilentlyContinue
}
```

token 只通过一行 stdin JSON 进入生产引擎，参数中没有 token。生产引擎不会读取环境变量；本地实测工具和 live 测试可以从本机环境取凭据。F1 接受备用源选项但不加载备用源。stdout 为 UTF-8 NDJSON；普通调试信息只能写 stderr。

上述路径已经保存本次完整实测缓存，可以直接增量更新，无需重新回补。`.local` 中的数据库、原始事件和测量报告均被 Git 忽略，不会进入 PR。要测试空缓存，请另选专用路径。

其他命令：

```powershell
uv run --project engines/finance python -m finance_engine status --db $financeDb

try {
  Set-TushareSessionToken
  @{ tushare_token = $env:TUSHARE_TOKEN } | ConvertTo-Json -Compress |
    uv run --project engines/finance python -m finance_engine verify --db $financeDb
} finally {
  Remove-Item Env:TUSHARE_TOKEN -ErrorAction SilentlyContinue
}

Test-Path Env:TUSHARE_TOKEN # 应返回 False
```

`status` 不读取 token、不创建数据库，已有数据库严格以只读连接打开。`verify` 只请求 `trade_cal`、`adj_factor` 各一行，不读写缓存。

重建：将 `update` 加上 `--mode full-rebuild`，会清除指定金融缓存后重新下载，预计 35–50 分钟；这是明确的手动操作，请先确认路径。首次日历请求失败时不清除已有缓存。不要把此命令的 `--db` 指向用户数据库。

## 数据与计算约定

- 日历从 2005 年开始；个股日线和因子从 2015 年开始；三指数估值从 2005 年开始，实际覆盖以返回数据为准。
- 最新交易日按北京时间判断，个股当日 16:00、指数当日 19:00 才尝试；可用时间之后返回空数据记 pending，历史起点之前的指数无数据记 empty。
- 每次重拉最近三个交易日，达到复权因子重试上限的日期只刷新日线。行情和完成标记以每个交易日一个事务提交。Python 的文件锁保护命令行和未来的 App 启动流程，异常退出会自动释放锁。
- `index` 阶段发布估值，`recent` 阶段完成最近 65 个交易日后发布最新两个个股指标，之后才回补历史。结果按 `(series_key, trade_date)` 存储，查询最新值取最大有效日期；缺依赖的 pending 不覆盖已有有效值。
- 60 日新高使用市场日历。窗口需要完整日线，只检查符合当日统计条件的股票所需因子。入选股票缺因子时保留日线，受影响窗口待补，分母保持原口径。某交易日连续三次成功取数仍缺因子时记 `error`，停止自动补取该日因子。网络和限流失败不计入三次。最近三日仍刷新日线并保留缓存因子。全量重建可重新取数。
- 估值的自然年窗口使用自然月偏移（5 年为 60 月，4.5 年为 54 月，10 年为 120 月，9 年为 108 月）；闰日截到目标月最后一天。分位包含当日，平值使用小于等于，原始 PE-TTM 无效时该日输出空值。
- 原始日线全部保留。`finance.db` 开启 WAL，结构由 Python 的 `meta.schema_version` 管理；未来升级只能增加迁移步骤，不改变已经发布的版本结构。
- 历史代码按有正式公告依据的证券身份关联，沿用 `stock_basic` 的原始上市日。按当日正式有效代码取日线和因子。目录缺码时整日记 `pending`，保留已有行情，继续后续日期，下次刷新目录后再取。同日不同身份的证券若收盘价和成交额都相同，发 `POSSIBLE_CODE_CHANGE` 警告供人工核对。有效代码缺失或同代码分页重复仍报错。
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

| code                          | 含义及处理                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------ |
| TOKEN_MISSING / TOKEN_INVALID | 缺少或无效 token（包括 HTTP 401），在本机重新设置，退出码 3                    |
| PERMISSION_DENIED             | 接口权限或积分不足（包括 HTTP 403），报告接口和脱敏后的上游错误，退出码 3      |
| RATE_LIMITED                  | 等待 60 秒，最多重试三次；仍失败时退出码 4，或更新中的单日记失败后继续         |
| NETWORK                       | 网络错误、HTTP 408 或 5xx，按 2、8、30 秒重试。首个请求仍失败时退出码 4        |
| DATA_NOT_READY                | 单日数据未发布、目录缺码或因子缺失时发 warning。因子达到上限后标为不可自动重试 |
| POSSIBLE_CODE_CHANGE          | 同日不同证券的收盘价和成交额完全相同，提示核对正式公告，按现有身份处理         |
| UPSTREAM_SCHEMA               | 字段、分页或数据结构变化，或其他不可重试的 HTTP 4xx，退出码 3                  |
| DB_BUSY                       | 锁被另一更新进程持有，退出码 4                                                 |
| DB_ERROR                      | 无法访问、损坏或版本不兼容，退出码 1；检查路径或重建                           |
| INTERNAL                      | 程序异常，退出码 1；提供脱敏后的错误和运行记录                                 |
| ARGUMENT                      | 命令、路径或参数格式错误，退出码 2                                             |

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

复查修正可在仓库根目录执行以下命令。测试会模拟 HTTP 状态、目录缺码、相同报价以及连续缺因子，使用临时数据库，无需 token。另可运行上面的 `verify` 命令，在结束后确认 `Test-Path Env:TUSHARE_TOKEN` 返回 `False`。

```powershell
uv run --project engines/finance --locked pytest engines/finance/tests/test_tushare.py engines/finance/tests/test_security_codes.py engines/finance/tests/test_engine_protocol.py -q
```

## 联网实测与记录

**当前状态（2026-11-08）：完整历史回补和重复增量更新均成功，全部 26 条序列的最新有效日期为 2026-11-06。分页、权限错误及参考值已实测；三轮有界限流探针均未触发限流，因此真实限流 code/msg 仍未观察到。**

联网对照测试（默认被 pytest 和 CI 排除）：

```powershell
try {
  Set-TushareSessionToken
  uv run --project engines/finance --locked pytest engines/finance/tests -m live -q
} finally {
  Remove-Item Env:TUSHARE_TOKEN -ErrorAction SilentlyContinue
}
```

完整测量工具：

```powershell
try {
  Set-TushareSessionToken
  uv run --project engines/finance --locked python engines/finance/scripts/live_validation.py --db $financeDb --probe-rate-limit
} finally {
  Remove-Item Env:TUSHARE_TOKEN -ErrorAction SilentlyContinue
}
```

工具检查 limit/offset 与完整响应的切片是否一致，以一行受限接口请求观察权限错误；`--probe-rate-limit` 仅在实测工具中最多发出 101 次、不同 offset 的 stock_basic 单行小请求，以排除相同请求缓存及分钟窗口边界的干扰，随后等待 65 秒释放配额。其他错误不会被误判为限流。生产客户端始终按全局 180 次/分钟、stock_basic 45 次/分钟限速。上游原始 code/msg 写进 probe 的 run_log；没有实际观察到的错误不会编造错误码。

工具随后正常更新，并报告实际数据库大小、耗时、各接口调用次数、指数覆盖起点、60 日新高 P5/P50/P95 和独立手算的三个交易日。`--probe-only` 可以只测接口而不回补历史。

| 项目                             | 结果                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| daily limit/offset 是否生效      | 通过：limit=3 的前两页分别与完整 5571 行响应的 [0:3]、[3:6] 完全一致                                                                                                           |
| 积分不足 code/msg                | kpl_list 权限负例返回 code=40203，msg 为“抱歉，您没有接口(kpl_list)访问权限，权限的具体详情访问：https://tushare.pro/document/1?doc_id=108。”；原始返回已写入 probe 的 run_log |
| 限流 code/msg                    | stock_basic 的 51/101 次请求约 5.67/7.52 秒、daily 的 201 次请求 22.00 秒，均 code=0；真实限流 code/msg 未观察到，生产仍按 180/45 次每分钟限制                                 |
| 2026-11-05 前5%占比、N、k        | 通过：44.203956917362156%、5217、261；显示一位小数为 44.2%                                                                                                                     |
| 2026-11-05 沪深300 PE-TTM / PB   | 通过：上游原始 13.5949 / 1.3393；按两位小数显示为 13.59 / 1.34，缓存保留四位原值                                                                                               |
| 三指数估值实际起点与首次调用次数 | 已完成：沪深300 2005-04-08、创业板指 2010-06-01、上证指数 2005-01-04；各 2 次调用                                                                                              |
| 从空缓存到完整历史的累计执行耗时 | 2065.33 秒，即 34 分 25 秒；包含一次断点续传，排除等待口径确认时间，详见下文                                                                                                   |
| finance.db 体积、日线数量        | 865239040 字节（825.16 MiB），11910747 条日线；2015-01-05 至 2026-11-06 的 2877 个交易日无缺口                                                                                 |
| 新高占比 P5 / P50 / P95          | 0.472441% / 3.618862% / 14.355466%；2818 个有效日，默认 20% / 3% 保持不变                                                                                                      |
| 三个交易日独立手算新高占比       | 2018-12-26、2020-09-28、2022-11-02 全部与缓存一致，详见下表                                                                                                                    |
| 重复增量更新                     | 14 次接口调用、9.62 秒、done.status=ok、new_dates 为空；指标内容哈希一致                                                                                                       |
| Python CI 时长预算               | 当日有效代码规则的独立 job 用时 52 秒，低于 5 分钟；同轮 Windows CI（含桌面编译）用时 5 分 20 秒并通过                                                                         |

本地记录（2026-11-08）：Python 不联网测试 42 项通过，live 对照测试 1 项通过；新增了真实权限码、历史代码连续性、有效代码及因子选择、有界限流探针和可复现随机抽样。现有 Vitest 143 项、pnpm lint、typecheck、Prettier、ruff 检查均通过；[当日有效代码规则的 Windows CI](https://github.com/roycelee597/WorkBench/actions/runs/42429409025) 全绿（Python 52 秒、Windows 5 分 20 秒）。

限流探针：前两轮为 stock_basic 的 51/101 次单行请求，第三轮在正常更新结束后单独发出 201 次 daily 单行请求，均改变 offset。第三轮确保探测落在同一分钟内，随后等待 65 秒释放配额；没有与正式更新并发。三轮均返回 code=0、msg 为空，原始结果已保存在本地 probe 运行记录。实际限流错误码保持未知，不能认定服务端没有限流，也不增加更多请求来强行触发；生产限速不放宽，限流分类与退避由模拟测试覆盖。

指数估值区间实测：从 2005-01-01 请求，沪深300实际首日 2005-04-08（5243行），创业板指 2010-06-01（3990行），上证指数 2005-01-04（5304行），最新日均为 2026-11-06；三个指数各用了 2 次 index_dailybasic 调用。

### 完整历史、断点续传与增量结果

这次从空缓存开始的实测分为两段，并非一次连续运行：

| 阶段           | 北京时间                     | 实际执行时间              | 结果                                                               |
| -------------- | ---------------------------- | ------------------------- | ------------------------------------------------------------------ |
| 初次回补       | 2026-11-08 02:32:38–02:46:04 | 805.73 秒                 | 在 2019-06-06 的旧新代码因子差异处受控停止；保留 1142 天与最新指标 |
| 确认口径后续传 | 2026-11-08 08:18:49–08:39:49 | 1259.60 秒                | 从缺口继续，完成全量历史，退出码 0、done.status=ok                 |
| 合计           | 不含两段之间的等待时间       | 2065.33 秒（34 分 25 秒） | 无 Tushare 限流失败，未重新下载已完成历史                          |

两段合计 5782 次调用，包括中断当天的重试、恢复运行的最近三日重拉和分页。首次请求三个指数估值各 2 次；续传时各再用 1 次刷新最近三日，不能把这一次计为首次完整拉取所需。index 和 recent 的最新结果事件均出现在 backfill 之前；完成历史计算后，26 条序列的最新有效日期仍为 2026-11-06。

`stock_daily` 和 `adj_factor` 的完成标记各有 2877 个成功交易日，逐日检查没有缺口。前 5% 序列有 2877 个有效日；新高序列前 59 个交易日因窗口不足为空，从 2015-04-03 起有 2818 个有效日；总计 122050 条指标记录。

新高复算使用固定随机种子 20261108，从全部有效日期中抽取三天，独立使用 SQL 和 Python 列表按 60 个市场交易日、至少 45 天交易、原始上市日及后复权价计算，不调用生产计算函数：

| 交易日     | 符合条件的股票数 N | 新高数 | 独立计算与缓存占比  |
| ---------- | ------------------ | ------ | ------------------- |
| 2018-12-26 | 3474               | 57     | 1.6407599309153715% |
| 2020-09-28 | 3839               | 24     | 0.6251628028132326% |
| 2022-11-02 | 4733               | 193    | 4.077751954362983%  |

2026-11-05 的新高占比为 3.620258039668785%（N=5193，新高 188）。历史 P5/P50/P95 使用全部 2818 个有效日计算，仅供 Royce 后续校准，F1 不调整默认阈值。

估值窗口的首个有效日也已核对；此前的空值是窗口覆盖不足，并非遗漏：

| 指数     | 全部（满 36 月） | 5 年（满 54 月） | 10 年（满 108 月） |
| -------- | ---------------- | ---------------- | ------------------ |
| 沪深300  | 2008-04-08       | 2009-10-09       | 2014-04-08         |
| 创业板指 | 2013-06-03       | 2014-12-01       | 2019-06-03         |
| 上证指数 | 2008-01-04       | 2009-07-06       | 2014-01-06         |

随后在同一完整缓存再运行 update，用时 9.62 秒：trade_cal 1 次、stock_basic 3 次、三指数估值各 1 次、沪深300 收盘 1 次、daily 和 adj_factor 各 3 次，总计 14 次。没有重复回补历史，`new_dates` 为空，26 条序列仍截至 2026-11-06。按序列和日期排序，比较键、日期、数值、extra_json（不比较每次更新的时间戳），前后 SHA-256 均为 `3c125f404756598652c398b6834fae525174345d1f6710b54105525fd10b4870`。

本机完整报告为 `engines/finance/.local/benchmark-report.json`，两段计时为 `benchmark-update-timing.json`、`resume-update-timing.json`，增量报告为 `incremental-report.json`，均位于被忽略的 `.local` 中。

最终脱敏检查已覆盖 277 个已跟踪文件、最终缓存和实测日志，共 961292229 字节（约 961 MB），未发现真实 token 原文（同时匹配 UTF-8 和 UTF-16LE）。检查只输出统计和通过与否，没有输出凭据。

### 已确认：别名因子冲突按当日有效代码取数

2019-06-06 的 000043.SZ / 001914.SZ，收盘价均为 9.96、成交额均为 66315.909 千元，但复权因子分别为 8.333 和 8.334；新代码生效日为 2019-12-16。初版严格规则拒绝合并，受控停止时该日没有半条数据写入。

Royce 已确认：按交易日当时正式有效代码取日线及因子，变更前用旧代码，变更后用新代码，忽略未生效代码的回写。该案例采用 000043.SZ 的因子 8.333，保持同一证券身份和原始上市日。规则已写入规格 §16.1 第 19 条，测试覆盖生效日前后、有效代码缺失、有效因子缺失及重复拒绝。

该日现已按确认口径成功写入，采用因子 8.333。初次停止前保留的 1142 天没有清空，续传后完整历史和最新指标均通过检查；累计执行时间与中断等待时间已在上文分开记录。

### 历史代码问题及修复依据

真实回补发现，`stock_basic` 和 `namechange` 用旧代码查询均返回空，但历史 daily/adj_factor 同日同时返回旧代码和当前代码，部分交易日因子存在差异。不能将同一证券计为两只，也不能删除旧代码数据后把更换代码误当作重新上市。

| 旧代码    | 当前代码  | 生效日     | 依据                                                                                                                    |
| --------- | --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 000022.SZ | 001872.SZ | 2018-12-26 | [发行人正式披露](https://disc.static.szse.cn/disc/disk03/finalpage/2022-08-31/ebcdc89c-4be1-4632-b0a3-4adba3c7204e.PDF) |
| 000043.SZ | 001914.SZ | 2019-12-16 | [深交所公告](https://www.szse.cn/disclosure/notice/general/t20191211_572534.html)                                       |
| 300114.SZ | 302132.SZ | 2025-02-17 | [发行人变更公告](https://static.cninfo.com.cn/finalpage/2025-02-07/1222485220.PDF)                                      |

当前代码的原始上市日分别为 1993-05-05、1994-09-28、2010-08-27，与历史身份一致。2015-01-05 上游 2347 行，关联并去重为 2344 只证券；数值不做改写。逐年首个交易日抽查均无剩余未知代码。测试覆盖跨变更日的 60 日窗口连续、相同别名只计一次、按生效日选取因子、有效代码重复回滚和未知代码拒绝。

其他参考值：2026-11-05 创业板指 PE-TTM 原始 29.0995（两位显示 29.10），上证指数原始 16.1253（两位显示 16.13）。

参考：[uv 官方 GitHub Actions 指南](https://docs.astral.sh/uv/guides/integration/github/)、[Tushare 日线接口](https://tushare.pro/document/2?doc_id=27)、[权限负例接口 kpl_list](https://tushare.pro/document/2?doc_id=347)。官方日线页没有列出 offset/limit，因此以实际分页探针结果为准。
