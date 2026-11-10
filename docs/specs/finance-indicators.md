# 金融指标工作台规格说明（v1 草案）

> 状态：**已确认**（2026-11-07）。实现时以本文件为准；与 ARCHITECTURE.md 冲突时，**本文件优先**（仅限金融指标工作台范围），并在 PR 中同步修订 ARCHITECTURE.md。
> 原先的待确认问题已由 Royce 于 2026-11-07 全部拍板，汇总在 §16.1；标「🔬 实现时实测」的是 Codex 实现时必须实测确认的技术点，汇总在 §16.2（不需要 Royce 决定）。Tushare 接口、积分和覆盖范围已于 2026-11-07 用 Royce 的 Tushare 账号（3000 积分）实测核对，见 §4.2。

## 1. 定位

- 内置工作台，id `com.royce.workbench.finance`，名称「金融指标」，在左侧工作台切换栏中排在「综合工作台」下面。
- 目标：每天打开 App 时自动补齐最新交易日数据，用图表展示几个 A 股市场指标，并在指标越过警戒线（阈值）时发**软件内提醒**。
- 分工：
  - **取数和计算**由独立的 Python 程序 `finance-engine` 完成，打包成可执行文件随 App 安装（Tauri sidecar），结果写进本地数据库 `finance.db`。
  - **App 只负责读结果、画图、管理阈值和提醒**，不在前端计算指标。
- 以后迁移到服务器：同一个 `finance-engine` 在服务器上每天定时运行，App 把数据源从「本地 sidecar」切换成「服务器 HTTP」，前端页面不用重写（见 §9.4）。
- Phase 2 插件运行时还没做，所以 v1 和综合工作台一样直接调用 core，所有数据调用都集中在 `workbenches/finance/src/api.ts`，Phase 2 再换成 SDK。

## 2. 布局

参考 Royce 提供的截图：左边是指标目录，右边是指标页面。

- **左列（指标目录）**：分组列表，组名可折叠。每项显示名称和最新值，越过阈值时显示红点或黄点。v1 的分组：
  | 分组     | 指标                                                 |
  | -------- | ---------------------------------------------------- |
  | 交易拥挤 | 前 5% 个股成交额占比                                 |
  | 市场宽度 | 创 60 日新高个股占比                                 |
  | 估值     | 沪深300 估值分位、创业板指估值分位、上证指数估值分位 |
- **右侧（指标页）**，从上到下：
  1. 标题行：指标名、数据截至日期（如「数据截至 2026-11-06」）、「立即更新」按钮。
  2. **当前值卡片**：最新值、较前一交易日的变化，以及阈值状态（正常 / 已高于 45%）。估值页另外显示原始 PE 或 PB 数值。
  3. **工具栏**：时间范围快捷键（1 年 / 3 年 / 5 年 / 全部，默认 3 年）；「叠加沪深300」开关（默认开）；按指标显示的专属开关（见 §5）。
  4. **折线图**：主轴是指标值，副轴（右侧）是沪深300 收盘点位；阈值显示为水平虚线并标出数值；底部有可拖动的范围缩放条；鼠标悬停显示当天所有数值。
  5. **说明区**：口径说明、怎么解读、阈值的含义（文字由指标元数据提供，见 §9.3）。
- 顶部或底部常驻一条**数据状态栏**：「正在更新：历史数据 1523/2876 天，预计还需 18 分钟」/「已是最新」/「更新失败：Tushare token 无效，去设置」。
- 首次使用（还没有 token）：右侧显示引导卡片「先在 设置 → 金融指标 填写 Tushare token」，并提供跳转按钮。
- 中文界面，跟随现有浅色/深色主题，图表配色随主题切换。

## 3. 更新时机（只在打开 App 时）

- **触发**：
  1. App 进程启动时，包括开机自启的 `--background` 启动，启动后延迟约 10 秒，避免和提醒补发抢资源。
  2. 用户点「立即更新」。
  3. 保存或更换 token 后自动更新一次。
- **不做**：App 常驻托盘时**不定时检查**（Royce 已确认）。所以如果 App 一直开着不重启，数据会停在上次启动时。状态栏会显示「数据截至 X 日」，提示可以手动更新。
- 已确认（2026-11-07）：从托盘重新打开主窗口、或者点进金融工作台时，即使数据已过期也**不自动更新**，只在 App 启动时更新（另有手动「立即更新」）。
- **同一时间只跑一个更新进程**：已经在跑时，「立即更新」按钮变成「更新中…」。
- 更新期间可以正常使用 App，也可以关掉窗口，关窗只是隐藏到托盘，更新会继续。退出 App 会终止更新，下次启动从断点继续（见 §8.3）。

### 3.1 「最新交易日」怎么判断

Tushare 各接口入库时间不同（官方文档写法略有出入，取较晚的为准）：

| 数据                       | 接口               | 当天数据大约何时可用（北京时间）   |
| -------------------------- | ------------------ | ---------------------------------- |
| 个股日线（成交额、收盘价） | `daily`            | 交易日 15:00–17:00                 |
| 复权因子                   | `adj_factor`       | 当天盘前 9:15–9:30                 |
| 指数估值（PE/PB）          | `index_dailybasic` | 交易日 19:00                       |
| 指数日线（沪深300 收盘）   | `index_daily`      | 交易日约 18:00–19:00，少数指数次日 |
| 交易日历                   | `trade_cal`        | 年底公布次年                       |

规则：

- `目标日` = 交易日历中 ≤ 今天的最后一个开市日。
- 每个数据集单独记录完成到哪天。如果当前时间早于该数据集的「最早尝试时间」（`daily` 16:00，`index_daily` 和 `index_dailybasic` 19:00），就不请求目标日的这个数据集，只补到前一个交易日。
- 在可用时间之后请求，返回却是空的，标记为 `pending`（还没出），**不算错误**，下次启动再试。状态栏显示「今日数据尚未发布，下次打开时补齐」。
- **每次更新都重拉最近 3 个交易日并重算**，以防 Tushare 事后修正数据。达到复权因子重试上限的日期只刷新日线（见 §5.2）。达到目录缺码重试上限时跳过该日的行情请求（见 §4.2）。阈值判断对重算的结果不会重复提醒（见 §7.3）。

## 4. 数据源

### 4.1 原则

- **Tushare 为主**，通过官方 HTTP 接口 `POST https://api.tushare.pro`（JSON：`api_name`、`token`、`params`、`fields`）直接调用，**不引入 `tushare` Python 包**。这样依赖更少、打包更小，也方便在测试里模拟。2026-11-07 已实测 HTTPS 可用，token 错误时返回 `code=40101`。
- **AKShare 为补充**，只在 Tushare 失败时用于**口径相同**的数据（见 §4.3）。口径不同的数据不混进同一条历史序列，否则分位数会失真。
- 每行数据都记录来源（`tushare` / `akshare`），界面上对来自备用源的点做标注。

### 4.2 用到的 Tushare 接口（3000 积分，已实测）

3000 积分属于「2000 以上」档：**每分钟 200 次、每个接口每天 100000 次**（来源：Tushare《积分与频次权限对应表》doc_id=290）。

| 接口               | 用途                                  | 积分要求             | 单次上限  | 调用方式                                                                                                  | 实测备注                                                                                      |
| ------------------ | ------------------------------------- | -------------------- | --------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `trade_cal`        | 交易日历                              | 2000                 | 120000 行 | 一次拉 2005-01-01 到年底，`exchange=SSE`                                                                  | 覆盖估值所需；个股日线仍从 2015 年开始                                                        |
| `stock_basic`      | 上市日期、交易所、退市状态            | 2000（每分钟 50 次） | 6000 行   | 按 `list_status` = L / D / P 各拉一次，含已退市股，避免幸存者偏差                                         |                                                                                               |
| `daily`            | 未复权收盘价、成交额 `amount`（千元） | 120 起               | 6000 行   | **按 `trade_date` 每天 1 次**                                                                             | 2026-11-05 返回 **5571 行**（沪 2316、深 2901、北 354），已接近 6000 上限，必须处理分页，见下 |
| `adj_factor`       | 复权因子                              | 2000                 | 6000 行   | 按 `trade_date` 每天 1 次                                                                                 | 2026-11-05 返回 5582 行，停牌股也有因子                                                       |
| `index_dailybasic` | 指数 PE / PE-TTM / PB                 | 2000                 | 3000 行   | 按指数代码 + 日期区间，**从 2005-01-01 起**（已确认，见 §5.3），每个指数约 2 次（约 5300 行，分两段请求） | 见下方覆盖说明                                                                                |
| `index_daily`      | 沪深300 收盘点位（叠加线）            | 2000                 | 10000 行  | `ts_code=000300.SH`，按区间 1 次                                                                          |                                                                                               |

**`index_dailybasic` 覆盖情况（重要）**：官方文档说只提供「上证综指、深证成指、上证50、中证500、中证1000、中小板指、创业板50、创业板指、科创50」，**没有列出沪深300**。但 2026-11-07 实测：

- `000300.SH`（沪深300）：有数据，2015-01-05 起每天都有（2015 年 PE 只有 2 位小数，近年有 4 位）。2026-11-05 的 PE-TTM 为 13.59，PB 为 1.34。`399300.SZ` 返回的数据与它相同。
- `399006.SZ`（创业板指）：有数据，2015-01-05 起，2026-11-05 PE-TTM 为 29.10。
- `000001.SH`（上证指数）：有数据，2026-11-05 PE-TTM 为 16.13。

所以三个指数都能用，但**沪深300 不在官方承诺范围内，以后有可能停止提供**。应对办法见 §4.3 和 §11。

2026-11-08 F1 复测补充：上述两位小数是展示精度，接口原始值为沪深300 PE-TTM 13.5949、PB 1.3393，创业板指 PE-TTM 29.0995、上证指数 PE-TTM 16.1253。缓存保留原始精度，参考值按两位小数核对，详见 `docs/finance-engine.md`。

历史证券代码变更须按正式公告和原始上市日关联同一证券。上游同日同时返回旧、新代码时，**按该交易日正式有效代码取日线和复权因子**。实际有效代码缺失或同一有效代码重复时仍报错。目录未收录的 `.BJ` 行发出 `UNKNOWN_BJ_CODE` 警告后跳过，其余日线照常处理。过滤后为空时按空响应标记 `pending` 并保留缓存。其他缺码使该日标记为 `pending`，下次刷新目录后重试。在三个不同的北京时间自然日收到有效日线响应仍缺码时标记 `error`，停止自动补取。同一自然日最多计一次，网络失败和空响应不计。重建缓存可重新取数。疑似代码变更检查只比较同日成交额为正的行。不同证券的收盘价和成交额完全相同时，发出 `POSSIBLE_CODE_CHANGE` 警告供人工核对。已核实的对应关系与来源记录在 F1 验证文档中。

**`daily` 的 6000 行上限**：今天全市场已有 5571 行，北交所还在扩容，迟早会超过 6000。`finance-engine` 必须这样处理：返回行数 = 6000 时，用 `offset` 参数继续翻页，直到不足 6000 行为止。🔬 实现时实测：`daily` 是否支持 `offset`/`limit`。如果不支持，就改为按交易所拆分请求，或者按 `ts_code` 列表分批请求。

**历史回补的调用量估算**：2015-01-05 至 2026-11-06 约 2876 个交易日，每天 `daily` 1–2 次加 `adj_factor` 1 次，**约 6000–8700 次**。限速设为每分钟 180 次（留 10% 余量），**首次回补大约 35–50 分钟**。之后每天只需几次到十几次调用。每天的总量远低于 100000 次的上限。

**用不到的接口**：`daily_basic`（2000 积分，有换手率、市值）这三个指标都不需要，v1 不调用。以后加「换手率」类指标时再用。

### 4.3 AKShare 备用源（v1 范围）

以 AKShare 1.20.35 的源码为准核对过函数签名：

| 用途             | AKShare 函数                                                                    | 数据来源         | v1 是否启用                      | 说明                                                                      |
| ---------------- | ------------------------------------------------------------------------------- | ---------------- | -------------------------------- | ------------------------------------------------------------------------- |
| 交易日历         | `tool_trade_date_hist_sina()`                                                   | 新浪             | ✅                               | 交易所日历，口径相同                                                      |
| 沪深300 收盘     | `stock_zh_index_daily(symbol="sh000300")` 或 `index_zh_a_hist(symbol="000300")` | 新浪 / 东方财富  | ✅                               | 交易所点位，口径相同                                                      |
| 当天全市场成交额 | `stock_zh_a_spot_em()`                                                          | 东方财富实时快照 | ✅ 仅「目标日 = 今天」时补指标 1 | 只有当天快照，不能补历史；收盘后的成交额与交易所一致，需过滤北交所        |
| 沪深300 PE/PB    | `stock_index_pe_lg` / `stock_index_pb_lg(symbol="沪深300")`                     | 乐咕乐股         | ❌ 只用于测试时对照              | 计算方法和 Tushare 不同，混进去会让分位失真；**不支持创业板指和上证指数** |
| 新高个股统计     | `stock_a_high_low_statistics(symbol="all")`                                     | 乐咕乐股         | ❌ 只用于测试时对照              | 定义与本规格不同                                                          |

- 设置里有「Tushare 失败时使用 AKShare 备用源」开关，默认开。
- **创业板指和上证指数的估值，以及历史个股日线，都没有口径一致的 AKShare 替代**。Tushare 不可用时，这些数据就停在 `pending`，下次再试。
- AKShare 依赖较多（如 `py_mini_racer`，含 V8 引擎），会明显增大安装包。已确认（2026-11-07）：放在单独的 PR-F5 里，**先实测安装包增加多少，再由 Royce 决定是否打包进去**。

## 5. 指标口径（v1 三个）

通用约定：

- **股票池**：沪深 A 股，也就是 `ts_code` 以 `.SH` / `.SZ` 结尾的股票，**不含北交所**（`.BJ`）。理由：北交所 2021-11 才开市，从中途加入会让历史序列出现断点；北交所成交额也很小。**已确认（2026-11-07）。**
- 当天没有 `daily` 行的股票视为**停牌**，不计入当天的任何统计。成交额 `amount ≤ 0` 的也视为停牌。
- ST 股、风险警示股都计入。
- 所有日期都用交易日 `YYYYMMDD`（整数存储），北京时间。

### 5.1 前 5% 个股成交额占比（`top5_turnover_share`）

- 当天股票池中成交额 > 0 的股票数记为 N。
- 按当天成交额从大到小排序，取前 `k = ceil(N × 5%)` 只。
- 值 = 这 k 只股票的成交额之和 ÷ N 只股票的成交额总和，用百分比显示，保留 1 位小数。
- 成交额相同时按 `ts_code` 排序，保证结果稳定。
- **月均**：把一个自然月内各交易日的日值取简单平均，由前端从日序列算出（纯函数，带单测）。当月还没结束时，最后一个点标注「本月至今」。
- 页面专属开关：**日线 / 月均**，**默认日线**，月均作为可切换视图（已确认 2026-11-07）。注意：这与参考截图（按月展示）以及草案原先的默认值（月均）不同，以本条为准。阈值始终用日值判断，两种视图都画阈值线。
- 实测参考值：2026-11-05，沪深 A 股 N=5217，k=261，占比 **44.2%**。这是单测和验收的对照值（§14、§15）。（仅供参考：如果包含北交所，结果是 N=5571，k=279，占比 45.2%，但股票池已确认不含北交所。）
- 默认阈值：**高于 45%**，提示交易拥挤、注意风险。

### 5.2 创 60 日新高个股占比（`new_high_60d_share`）

- **价格用后复权收盘价** `adj_close = close × adj_factor`。理由：
  - 判断「今天的价格是不是窗口内最高」只和窗口内价格的**相对大小**有关。前复权价和后复权价之间只差一个常数倍（同一只股票在同一时点），所以两种算法结果**完全相同**。
  - 前复权价每次分红送股后都要改写全部历史，增量计算麻烦。后复权价一旦算出就不会再变，适合逐日增量计算，也方便以后搬到服务器。
  - 不能用未复权价，否则除权会造成「假跌」，让复权前的高点永远不可超越，统计结果会偏低。
- **窗口**：截至当天（含）的最近 **60 个市场交易日**（按交易日历计，不按个股自己的交易天数计）。
- **符合条件的股票**（分子和分母都只算这些）：
  1. 当天有交易（非停牌）。
  2. 上市满 60 个交易日：`list_date` 早于或等于窗口的第一天，即上市不满 60 天的新股不算。
  3. 窗口内至少有 **45 天**有交易数据。否则停牌很久后复牌的股票，窗口里只剩几天数据，会被误判为「新高」。
- **新高判断**：当天 `adj_close` ≥ 窗口内**其它交易日** `adj_close` 的最大值（平了也算新高）。
- 值 = 新高股票数 ÷ 符合条件的股票数，百分比，保留 1 位小数。
- 分母：**符合条件的股票数**，即排除新股和停牌太久的股票，让分子分母口径一致。已确认（2026-11-07），取代原话中的「当天全 A 股票数」。
- 默认阈值：**高于 20%** 提示普涨、情绪过热；**低于 3%** 提示市场很弱。已确认（2026-11-07）先按这两个值上线。首次完整回补后，在 `docs/finance-verification.md` 里列出历史分布（P5 / P50 / P95），再由 Royce 决定是否校准默认值。
- 依赖：计算第 d 天需要 d 往前 59 个交易日的日线和复权因子，所以 2015 年最初约 3 个月没有值。图上从第一个有值的日子开始画。
- 窗口日线需完整，因子只检查符合分母条件的股票。入选股票缺因子时保留日线，受影响结果标为未就绪，按原分母等待补齐。某交易日在三个不同的北京时间自然日取数仍缺因子时标记 `error`，暂停自动请求该日因子。同一自然日最多计一次，网络或限流失败不计。最近三日仍刷新日线并保留缓存因子，重建缓存可重新取数。

### 5.3 主要指数估值分位（`index_valuation`）

- 指数：沪深300 `000300.SH`、创业板指 `399006.SZ`、上证指数 `000001.SH`。
- 指标：只用 **PE-TTM**（滚动市盈率，默认）和 **PB**（市净率），**不展示静态 PE**。已确认（2026-11-07）。静态 PE（`pe` 字段）仍然入库，但界面不展示。
- **分位**：第 d 天的分位 = 窗口内 ≤ 当天值的天数 ÷ 窗口内有值的天数 × 100%。窗口只用 d 当天及以前的数据（**不使用未来数据**），所以画出来的历史分位曲线和当时实际看到的一致。
- **估值历史起点：2005-01-01**（已确认，2026-11-07）。`index_dailybasic` 的数据从 2004 年起就有，每个指数只需多一两次调用。**只有估值数据单独从 2005 年开始**，个股日线（指标 1、2）仍从 2015 年开始。创业板指 2010-06 才发布，从发布日开始。
- **三个窗口**，现在三者有实际区别：
  - **5 年**：d 往前 5 个自然年。窗口内数据不足 4.5 年时，当天为空，所以约 2009 年中以前没有值。
  - **10 年**：d 往前 10 个自然年。不足 9 年时为空，所以约 2014 年以前没有值（创业板指约 2019 年起才有值）。
  - **全部**：从该指数第一条估值数据起到 d 的扩展窗口，至少 3 年才出值。
  - 估值页的图表可以显示 2005 年起的全部历史。估值页的范围快捷键「全部」从 2005 年起，其它指标的「全部」从 2015 年起。
- PE ≤ 0 或缺失的日子不参与分位计算，当天显示为空（这三个指数实际上极少出现）。
- 页面专属开关：指数切换（三个页签）、**PE-TTM / PB**、**窗口 5 年 / 10 年 / 全部**（默认 10 年）、**分位 / 原始值** 视图（默认分位，纵轴为 0–100%）。
- 默认阈值：对**每个指数的 PE-TTM 10 年分位**，**低于 20%** 提示便宜，**高于 80%** 提示偏贵，共 6 条。PB 和其它窗口没有默认阈值，用户可以自己加。

## 6. 图表

- 选型：**Apache ECharts**（Apache-2.0 许可证，可商用，允许闭源分发，符合本项目 MIT 开源的要求）。
  - 原生支持双纵轴（指标和沪深300）、阈值虚线（`markLine`）、范围缩放条（`dataZoom`）、悬停提示、深色主题，以及 1 万点以上的大数据量。
  - 直接用 `echarts/core` 按需引入（只引 LineChart、Grid、Tooltip、DataZoom、MarkLine、Legend），React 中自己写一个约 50 行的 `<Chart option={…}/>` 包装，不引入 `echarts-for-react`，少一个依赖。
  - 金融工作台整体用 `React.lazy` 动态加载，不让主包继续变大（已有 Vite 包体积警告）。
- 指标日线序列在各自已有记录的首尾之间，按交易日历给缺行的开市日补空值，保留已有空值。折线在空值处断开。占比图纵轴随可见数据缩放并包含阈值，估值分位轴固定为 0–100%。
- 对比过：TradingView `lightweight-charts`（Apache-2.0，但要求保留 TradingView 署名，而且偏向 K 线，双轴和阈值线不如 ECharts 方便）；Recharts（MIT，大数据量时卡顿，缩放要自己做）。
- 图表配置由纯函数 `buildChartOption(series, overlay, thresholds, view)` 生成，方便单测。
- 沪深300 叠加：副轴，灰色细线，图例可以点击隐藏，状态记入设置（`finance.overlay_hs300`）。

## 7. 阈值与提醒

### 7.1 阈值模型

- 每条阈值绑定一个**序列**（`series_key`，见 §10.1），字段包括：方向（高于 / 低于）、数值、回差、启用、备注。
- 每个指标可以有多条阈值。用户可以在指标页的「阈值」面板里**修改、停用、删除（软删除）和新增**。
- 首次看到某个指标时，按指标元数据里的默认值**自动写入默认阈值**（`default_key` 去重，删了也不会再自动加回来）。

| 默认阈值         | 序列                              | 方向 | 数值 | 回差         |
| ---------------- | --------------------------------- | ---- | ---- | ------------ |
| 交易拥挤         | `top5_turnover_share`             | 高于 | 45%  | 1 个百分点   |
| 普涨过热（暂定） | `new_high_60d_share`              | 高于 | 20%  | 1 个百分点   |
| 市场很弱（暂定） | `new_high_60d_share`              | 低于 | 3%   | 0.5 个百分点 |
| 估值便宜 ×3      | `valuation.<指数>.pe_ttm.pct_10y` | 低于 | 20%  | 5 个百分点   |
| 估值偏贵 ×3      | `valuation.<指数>.pe_ttm.pct_10y` | 高于 | 80%  | 5 个百分点   |

### 7.2 触发规则（只在「越过」时提醒）

- 每条阈值有一个状态：`breached`（是否已越过）。
- 第 d 天的值越过阈值，且前一状态为「未越过」时，记为**一次越线**，状态变为「已越过」。
- 状态从「已越过」恢复为「未越过」，需要回落到**阈值 ± 回差**以内。例如 45% 阈值、1 个百分点回差，要回落到 44% 以下才重置。这样在 45% 附近来回波动时，不会天天提醒。
- 只有**越线**才提醒，连续多天停在阈值之外**不重复提醒**。
- **首次计算**（新阈值，或回补完成后第一次评估）：只根据最新值静默设置初始状态，**不发提醒**。如果当前已越过阈值，左列和卡片上显示「已高于阈值」标记。这样首次装好不会一次弹出 6 条以上的提醒。
- **修改阈值**（数值、方向或回差）后，同样按最新值静默重设状态。
- **补算多天**（比如一周没开 App）：按日期顺序逐日评估新算出的日子。只有在补算期间发生过越线，并且**最新一天仍在阈值之外**，才提醒一次。正文写明首次越线的日期和最新值。
- 只评估本次**新算出的日子**。历史回补的日子只用来推算状态，不提醒。
- 重算的最近 3 个交易日（§3.1）：如果某天的状态已经评估过，就不再重复提醒。

### 7.3 写入提醒系统

- 一次越线 → 在 `reminders` 表新建一条提醒，`due_at = 当前时间`。现有调度器会在 30 秒内（或数据变动时立即）弹出**软件内通知条**，带「完成」「稍后 10 分钟」按钮。窗口在托盘时，会先唤起窗口再弹出。完全复用现有机制，不新增通知方式。
- 字段：
  - `title`：「金融指标：前5%成交额占比升至 46.2%（阈值 45%）」
  - `notes`：数据日期、首次越线日期、阈值含义的一句话。
  - `source = 'manual'`，`source_workbench = 'com.royce.workbench.finance'`，`priority = 2`（中）。
  - 选 `source='manual'` 的原因：`0001_init.sql` 里 `reminders.source` 有 `CHECK (source IN ('manual','event'))` 约束，SQLite 不能直接修改 CHECK，必须重建整张表，风险大。所以用 `source_workbench` 区分来源，提醒页对这类提醒显示一个「金融」小图标。
  - 这些提醒会出现在「提醒事项 → 今天 / 全部」里，可以像普通提醒一样勾选完成。已确认（2026-11-07）。
- **同一次更新中有 3 条及以上阈值越线**时，合并成一条提醒：「金融指标：3 条阈值被触发」，正文逐条列出。
- 新建提醒和写入 `finance_alert_states` 在**同一个 `execute_batch` 事务**里完成，避免重复提醒。
- 点击通知条主体：打开对应的指标页。注意：现有的 `NotificationAction.open` 只会跳到提醒页，需要扩展：如果提醒的 `source_workbench` 是金融工作台，就跳到指标页。实现方式由 PR-F4 决定，并补单测。

## 8. Python 程序 `finance-engine`

### 8.1 位置与技术

- 代码放在 `engines/finance/`，Python 3.12，用 `uv` 管理依赖。
- 依赖尽量少：`httpx`（HTTP）、`pandas` + `numpy`（计算），测试用 `pytest`、`respx`（模拟 HTTP），代码检查用 `ruff`。AKShare 是可选依赖（`[project.optional-dependencies] akshare`）。
- 结构：
  ```text
  engines/finance/
  ├─ pyproject.toml
  ├─ finance_engine/
  │  ├─ __main__.py          # 命令行入口
  │  ├─ protocol.py          # 标准输入 / 标准输出协议（§8.2）
  │  ├─ db.py                # finance.db 连接、迁移、WAL
  │  ├─ ratelimit.py         # 令牌桶限速
  │  ├─ sources/
  │  │  ├─ tushare.py        # HTTP 客户端、分页、错误映射
  │  │  └─ akshare_fallback.py
  │  ├─ datasets/            # 每个原始数据集一个模块：拉取 + 入库 + 就绪时间
  │  │  ├─ trade_cal.py  stock_basic.py  stock_daily.py  adj_factor.py
  │  │  └─ index_daily.py  index_valuation.py
  │  ├─ indicators/          # 每个指标一个模块（§9.3 扩展点）
  │  │  ├─ base.py           # Indicator 协议
  │  │  ├─ top5_turnover.py  new_high_60d.py  index_valuation.py
  │  └─ planner.py           # 算出「缺哪些天、先做什么」
  └─ tests/
  ```
- 打包：用 **PyInstaller 单文件模式**生成 `finance-engine-x86_64-pc-windows-msvc.exe`，放在 `apps/desktop/src-tauri/binaries/`（不进 Git，由脚本和 CI 生成），通过 `tauri.conf.json` 的 `bundle.externalBin` 随安装包分发。单文件模式每次启动要解压，大约慢 2–5 秒，对每天一次的更新来说可以接受。
- 开发模式：`pnpm finance:engine` 脚本先打包一次 sidecar。也可以设置环境变量 `WORKBENCH_FINANCE_ENGINE_DEV=1`，让 Rust 改用 `uv run python -m finance_engine` 启动，省得每次改代码都重新打包。

### 8.2 App 和 Python 怎么通信

**命令行参数**（不包含任何密钥）：

```text
finance-engine update  --db <finance.db 绝对路径> [--mode auto|full-rebuild] [--now 2026-11-07T20:00:00+08:00]
finance-engine verify  --db <路径>          # 只检查 token 和积分，不写数据
finance-engine status  --db <路径>          # 输出各数据集和指标的完成情况
finance-engine --version
```

`--now` 只在测试时用来固定时间。

**token 通过标准输入传入**：进程启动后，Rust 往 stdin 写一行 JSON，然后关闭 stdin：

```json
{ "tushare_token": "…", "akshare_fallback": true }
```

- token **不进命令行参数**（同一用户的其它进程能看到命令行），**不进环境变量**，**不写日志**。Python 端所有日志和错误信息都要把 token 打码（单测覆盖）。
- 服务器模式下，同样的 JSON 可以从文件或服务器的密钥管理读取（`--secrets-file`，v1 不实现）。

**进度和结果通过标准输出报告**，每行一条 JSON（NDJSON）。stderr 只写调试日志：

```json
{"type":"hello","engine_version":"0.1.0","schema_version":1}
{"type":"stage","stage":"calendar"}
{"type":"progress","stage":"backfill","done":1523,"total":2876,"current":"20210315","eta_seconds":1080}
{"type":"indicator_updated","indicator":"top5_turnover_share","through":"20261106"}
{"type":"warning","code":"DATA_NOT_READY","dataset":"index_valuation","trade_date":"20261107"}
{"type":"error","code":"TOKEN_INVALID","message":"Tushare token 无效，请在设置中重新填写","retryable":false}
{"type":"done","status":"ok|partial|failed","new_dates":{"top5_turnover_share":["20261106"]},"through":{"…":"20261106"}}
```

- 阶段顺序：`calendar` → `stock_basic` → `index`（估值和沪深300，几次调用就完成）→ `recent`（最近 65 个交易日的个股数据，先让三个指标的**最新值**在几分钟内出来）→ `backfill`（从 2015 年起按日期升序补齐其余历史）→ `compute` → `done`。
- 分阶段发布：`index` 和 `recent` 完成后立即计算并发布各自可用的最新结果；完整回补后再统一补算历史。按序列与交易日更新，不得让历史补算把最新值覆盖成更旧或错误的结果。
- Rust 把每行转发为前端事件 `finance://event`，前端用 zod 校验后更新状态栏。`done.new_dates` 告诉前端哪些日子是新算出来的，用于阈值评估（§7.2）。
- 退出码：0 = 正常或部分完成（看 `done.status`）；2 = 参数错误；3 = 不可重试的错误（token 或权限）；4 = 可重试的错误（网络、限流）；其它 = 程序异常。

### 8.3 断点续传、限速和容错

- **断点续传**：每个交易日的原始数据 +「已完成」标记在**一个事务**里提交。被中断（退出 App、断网、崩溃）后，下次运行由 `planner` 根据 `dataset_status` 只补缺的天，不重复、不缺漏。
- **限速**：令牌桶，所有接口合计每分钟 180 次（`stock_basic` 单独每分钟 ≤ 45 次）。遇到 Tushare 的限流提示（错误信息含「每分钟最多访问」之类的字样），等 60 秒后重试。
- **重试**：网络错误、HTTP 408 和 5xx 按 2 / 8 / 30 秒重试三次，HTTP 429 按限流规则等待 60 秒重试三次。单日仍失败时标记失败并继续处理后续日期，最后的状态为 `partial`。HTTP 401 对应 token 无效，403 对应权限不足，其余 4xx 对应上游请求异常，均立即报错。
- **错误分类**（前端按 `code` 显示中文提示）：

| code                   | 场景                 | 可重试        | 界面提示                 |
| ---------------------- | -------------------- | ------------- | ------------------------ |
| `TOKEN_MISSING`        | 未设置 token         | 否            | 去设置填写               |
| `TOKEN_INVALID`        | Tushare 返回 40101   | 否            | token 无效，去设置       |
| `PERMISSION_DENIED`    | 积分不足或接口无权限 | 否            | 显示接口名和所需积分     |
| `RATE_LIMITED`         | 限流，重试后仍失败   | 是            | 稍后自动重试             |
| `NETWORK`              | 断网或超时           | 是            | 网络不可用，下次打开再试 |
| `DATA_NOT_READY`       | 当天数据未发布       | 是（warning） | 今日数据尚未发布         |
| `UPSTREAM_SCHEMA`      | 返回字段和预期不一致 | 否            | 数据源格式变化，请反馈   |
| `DB_BUSY` / `DB_ERROR` | 数据库被锁或损坏     | 视情况        | 提供「重建金融数据」入口 |
| `INTERNAL`             | 其它                 | 否            | 显示日志位置             |

- 🔬 实现时实测：Tushare 的「积分不足」和「限流」错误码没有公开文档。实现时根据返回的 `code` 和 `msg` 关键词判断，并把原始 `code` 和 `msg` 写进 `run_log`，不要瞎猜。
- **离线**：断网时第一个请求就失败 → 状态 `NETWORK`，只允许写 `run_log` 记录失败，行情、指标和完成标记保持不变；图表照常显示已有数据，状态栏显示「离线，数据截至 X 日」。
- **单实例**：Rust 保证同时只有一个 sidecar 进程。Python 端另外对数据库目录加锁文件（`finance.db.lock`），防止开发时手动运行冲突。
- **取消**：取消或退出 App 时，Rust 先通过本次运行专属的控制文件通知引擎退出，等待最多 5 秒，再对仍在运行的进程树执行强制结束。每天的数据独立提交。引擎的临时文件留在本次运行专属目录，进程结束后由 Rust 清理，失败时记录警告。测试连接约 60 秒时发出停止信号，并使用同一套收尾规则。Rust 将 stderr 打码后写入应用日志目录的 `finance-engine.log`，按 1 MiB 轮转并保留最近一份归档。

### 8.4 `full-rebuild`

设置页的「重建金融数据」会删除 `finance.db`（这是可再生的缓存，不是用户数据），然后全量重拉。执行前弹窗确认，提示约需 35–50 分钟。阈值和提醒状态存在 `workbench.db` 里，不受影响。

## 9. App 端集成

### 9.1 Rust（尽量少，只做系统能力）

新文件 `src-tauri/src/finance.rs`，所有命令只允许 `main` 窗口调用（和 `execute_batch` 一样检查 `window.label()`）：

| 命令                         | 作用                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `finance_token_set(token)`   | 存入 Windows 凭据管理器                                                                                                        |
| `finance_token_status()`     | 只返回 `{ configured: bool, tail: "末4位" }`，**永远不把 token 返回给前端**                                                    |
| `finance_token_clear()`      | 删除凭据                                                                                                                       |
| `finance_update_start(mode)` | 读取凭据 → 启动 sidecar → 把 token 写进 stdin → 把 stdout 每行转发为 `finance://event`；已经在运行时直接返回 `already_running` |
| `finance_update_cancel()`    | 结束子进程                                                                                                                     |
| `finance_verify()`           | 运行 `finance-engine verify`，返回结果                                                                                         |
| `finance_db_path()`          | 返回 finance.db 路径，用于显示和「打开文件夹」                                                                                 |

- **token 加密保存**：用 Rust 的 `keyring` crate（v3，MIT/Apache-2.0），在 Windows 上存进**凭据管理器**（Credential Manager，由系统用当前用户的登录凭据加密），服务名 `com.royce.workbench.finance`，账户名 `tushare`。token 不写进 SQLite、设置 JSON 或日志。
  - 没选 `tauri-plugin-stronghold`：它需要额外的密码或盐管理，对新手偏复杂，而且官方计划弃用。
  - 换电脑或以后同步时，token **不同步**，需要在新设备上重新填。
- **启动 sidecar**：用 `tauri-plugin-shell`，**只在 Rust 端调用**（`app.shell().sidecar("finance-engine")`）。**不给前端任何 shell 权限**，`capabilities/default.json` 不加 `shell:*`。
- 新增 Rust 依赖 `keyring`、`tauri-plugin-shell` **已由 Royce 同意**（2026-11-07，见 §16.1）。

### 9.2 读取 finance.db

- finance.db 和 workbench.db 是**两个独立文件**：
  - `workbench.db`：用户数据（备忘录、阈值、提醒），带同步字段，以后要同步。
  - `finance.db`：市场数据和指标结果，是**可再生的缓存**，由 Python 独占写入，**不参与同步**，所以不带 5 个同步字段。这也是为了以后切换到服务器数据源时，App 端只换「读哪里」。
- 位置：`%LOCALAPPDATA%\com.royce.workbench\finance.db`。F2 在 Windows 的隔离 Tauri 实例中确认 `tauri-plugin-sql` 支持绝对路径。`workbench.db` 继续使用 Roaming 应用数据目录。
- Rust 只读打开固定路径的 `finance.db` 并向 `tauri-plugin-sql` 注册连接，前端用 `select` 查询。`core/finance/finance-reader.ts` 统一封装。主窗口通过专用命令打开和关闭金融连接，通用的 `sql:allow-load` 和 `sql:allow-close` 不授予 WebView。
- Python 开启 WAL 模式，所以 App 读的同时 Python 也能写。

### 9.3 扩展：以后加一个新指标要做什么

1. 在 `engines/finance/finance_engine/indicators/` 新增一个模块，实现 `Indicator` 协议：
   ```python
   class Indicator(Protocol):
       id: str                      # 'top5_turnover_share'
       depends_on: list[str]        # ['stock_daily']（原始数据集名）
       lookback_days: int           # 需要往前多少个交易日的数据
       def meta(self) -> dict: ...  # 显示用元数据（见下）
       def compute(self, ctx: ComputeContext, dates: list[int]) -> list[SeriesPoint]: ...
   ```
2. 在 `indicators/__init__.py` 的注册表里加一行。
3. 如果需要新的原始数据，在 `datasets/` 里加一个模块（声明接口、就绪时间、拉取方式）。
4. 写 pytest 单测。

**App 端不用改代码**：Python 每次运行都会把每个指标的元数据写进 `finance.db.indicator_meta`，App 根据元数据通用地渲染左列条目、指标页、开关和说明。元数据 JSON 示例：

```json
{
  "id": "top5_turnover_share",
  "name": "前5%个股成交额占比",
  "group": "交易拥挤",
  "order": 10,
  "unit": "percent",
  "decimals": 1,
  "series": [{ "key": "top5_turnover_share", "label": "日值", "primary": true }],
  "views": { "monthly_avg": true, "overlay_hs300": true },
  "default_thresholds": [
    {
      "default_key": "top5_gt_45",
      "series_key": "top5_turnover_share",
      "direction": "above",
      "level": 45,
      "hysteresis": 1,
      "label": "交易拥挤"
    }
  ],
  "description_md": "**口径**：……\n**解读**：……"
}
```

估值这类有「指数 × 指标 × 窗口」多个维度的，用 `"dimensions"` 字段描述页签和开关。v1 只支持本规格用到的几种视图类型，以后需要新的视图时再扩展前端。

### 9.4 数据源接口（为服务器模式预留）

```ts
interface FinanceDataSource {
  listIndicators(): Promise<IndicatorMeta[]>;
  getSeries(keys: string[], range?: { from: number; to: number }): Promise<SeriesData[]>;
  getStatus(): Promise<FinanceStatus>; // 各数据集完成到哪天、最近一次运行结果
  requestUpdate(mode?: "auto" | "full-rebuild"): Promise<void>;
  onEvent(cb: (e: EngineEvent) => void): () => void;
}
```

- v1 只实现 `LocalSidecarSource`（读 finance.db 和 Rust 命令）。
- 以后的 `HttpSource`：服务器每天收盘后运行 `finance-engine update`，再提供只读 API（例如 `GET /indicators`、`GET /series?keys=…`）。App 在设置里切换数据源，阈值和提醒逻辑不变：阈值仍在本地评估，评估依据是 `getStatus` 返回的新日期。
- 阈值评估器只依赖 `FinanceDataSource`，不依赖 sidecar。

### 9.5 前端模块

```text
workbenches/finance/
├─ src/
│  ├─ FinanceWorkbench.tsx      # 左列 + 右侧指标页
│  ├─ api.ts                    # 唯一的数据出入口（Phase 2 换 SDK）
│  ├─ components/ IndicatorList.tsx  IndicatorPage.tsx  ValueCard.tsx  Chart.tsx  ThresholdPanel.tsx  StatusBar.tsx  TokenSettings.tsx
│  ├─ chart-option.ts           # buildChartOption 纯函数
│  ├─ monthly.ts                # 月均纯函数
│  ├─ threshold-evaluator.ts    # §7.2 纯函数
│  └─ finance-store.ts          # Zustand
└─ tests/
apps/desktop/src/core/finance/  # finance-reader.ts、local-sidecar-source.ts、事件 zod 模型
apps/desktop/src/core/repositories/finance-thresholds.ts  finance-alert-states.ts
```

- `AppShell` 侧边栏增加「金融指标」入口；`SettingsPage` 增加「金融指标」分区（§12）。

## 10. 数据表

### 10.1 finance.db（Python 独占写入，不同步，可整库重建）

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- schema_version、engine_version、created_at
CREATE TABLE trade_calendar (cal_date INTEGER PRIMARY KEY, is_open INTEGER NOT NULL);
CREATE TABLE securities (                                               -- 来自 stock_basic
  sid INTEGER PRIMARY KEY,                                              -- 本地自增整数，节省 stock_daily 空间
  ts_code TEXT NOT NULL UNIQUE, name TEXT, exchange TEXT, market TEXT,
  list_date INTEGER, delist_date INTEGER, list_status TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE stock_daily (                                              -- daily + adj_factor 合并
  trade_date INTEGER NOT NULL, sid INTEGER NOT NULL,
  close REAL NOT NULL, amount REAL NOT NULL,                            -- amount 单位：千元
  adj_factor REAL,                                                      -- 后复权价 = close × adj_factor
  source TEXT NOT NULL DEFAULT 'tushare',
  PRIMARY KEY (trade_date, sid)
) WITHOUT ROWID;
CREATE TABLE index_daily (ts_code TEXT, trade_date INTEGER, close REAL NOT NULL, source TEXT NOT NULL DEFAULT 'tushare',
  PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID;
CREATE TABLE index_valuation (ts_code TEXT, trade_date INTEGER, pe REAL, pe_ttm REAL, pb REAL, source TEXT NOT NULL DEFAULT 'tushare',
  PRIMARY KEY (ts_code, trade_date)) WITHOUT ROWID;
CREATE TABLE dataset_status (                                           -- 断点续传依据
  dataset TEXT NOT NULL, trade_date INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','empty','pending','error')),
  rows INTEGER, source TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (dataset, trade_date)
) WITHOUT ROWID;
CREATE TABLE indicator_meta (indicator_id TEXT PRIMARY KEY, meta_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE indicator_values (
  series_key TEXT NOT NULL, trade_date INTEGER NOT NULL,
  value REAL,                                                          -- NULL = 当天无值（窗口不足等）
  extra_json TEXT,                                                     -- 例如 {"n":5217,"k":261} 便于核对
  computed_at INTEGER NOT NULL, engine_version TEXT NOT NULL,
  PRIMARY KEY (series_key, trade_date)
) WITHOUT ROWID;
CREATE TABLE run_log (
  run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
  mode TEXT NOT NULL, status TEXT, error_code TEXT, error_message TEXT, summary_json TEXT
);
```

- **序列键**（`series_key`）：
  - `top5_turnover_share`、`new_high_60d_share`
  - `valuation.<ts_code>.<pe_ttm|pb>.raw`
  - `valuation.<ts_code>.<pe_ttm|pb>.pct_5y|pct_10y|pct_all`
  - 三个指数共 3 × 2 × 4 = 24 条序列。沪深300 叠加线直接读 `index_daily`。
- **体积**：`stock_daily` 约 2876 天 × 平均约 4300 只 ≈ 1200 万行，预计 **400–700 MB**。PR-F1 要实测并写进文档。已确认（2026-11-07）：**保留全部原始日线**，以后加新指标时不用重新下载。
- schema 的升级由 Python 自己的迁移负责（`meta.schema_version`）。App 读取时检查版本，不兼容就提示「请更新 App」。

### 10.2 workbench.db（新增迁移 `0003_finance.sql`，带同步字段）

```sql
CREATE TABLE finance_thresholds (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, device_id TEXT NOT NULL, deletion_group_id TEXT, purged_at INTEGER,
  indicator_id TEXT NOT NULL,
  series_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  level REAL NOT NULL,
  hysteresis REAL NOT NULL DEFAULT 0 CHECK (hysteresis >= 0),
  enabled INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  default_key TEXT                                    -- 默认阈值来源；用户删了也不再自动补
);
CREATE UNIQUE INDEX idx_finance_thresholds_default ON finance_thresholds(default_key) WHERE default_key IS NOT NULL;
CREATE INDEX idx_finance_thresholds_series ON finance_thresholds(series_key) WHERE deleted_at IS NULL;

CREATE TABLE finance_alert_states (                   -- 每条阈值一行
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, device_id TEXT NOT NULL, deletion_group_id TEXT, purged_at INTEGER,
  threshold_id TEXT NOT NULL REFERENCES finance_thresholds(id),
  threshold_version INTEGER NOT NULL,                 -- = 阈值的 updated_at，阈值改了就静默重置状态
  breached INTEGER NOT NULL,
  evaluated_through INTEGER NOT NULL,                 -- 已评估到哪个交易日
  last_crossed_date INTEGER,
  last_reminder_id TEXT REFERENCES reminders(id)
);
CREATE UNIQUE INDEX idx_finance_alert_state_threshold ON finance_alert_states(threshold_id) WHERE deleted_at IS NULL;
```

- 在 `src-tauri/src/lib.rs` 登记 version 3。
- 阈值走软删除，但**不进回收站界面**（v1，已确认 2026-11-07）。
- settings（kv）新增键：`finance.akshare_fallback`（默认 true）、`finance.overlay_hs300`（默认 true）、`finance.default_range`（`3y`）、`finance.valuation_window`（`10y`）、`finance.valuation_metric`（`pe_ttm`）、`finance.valuation_index`（默认元数据的第一个指数）、`finance.valuation_view`（`percentile`）、`finance.top5_view`（`daily`）、`finance.initial_backfill_confirmed`、`finance.last_selected_indicator`。
- `reminders` **不改表**（理由见 §7.3）。

## 11. 失败场景

| 场景                            | 表现                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| 没有 token                      | 不启动 sidecar；指标页显示引导卡片                                                         |
| token 无效或积分不足            | 状态栏红色提示，附「去设置」按钮；已有数据照常显示                                         |
| 断网或 Tushare 宕机             | 状态 `NETWORK`；可用 AKShare 的数据（日历、沪深300、当天成交额）照常补；其它保持 `pending` |
| 当天数据未发布                  | 只补到前一个交易日，显示「今日数据尚未发布」                                               |
| 首次回补中途退出                | 下次启动从断点继续；进度条显示总进度                                                       |
| 沪深300 估值不再由 Tushare 提供 | 该指数显示「数据源暂不可用」，其它两个指数正常；需要另找数据源（§16）                      |
| `daily` 超过 6000 行            | 翻页（§4.2），单测覆盖                                                                     |
| 杀毒软件拦截或 sidecar 缺失     | `finance_update_start` 返回 `ENGINE_MISSING`，提示重新安装，并附日志路径                   |
| finance.db 损坏或版本不兼容     | 提示「重建金融数据」                                                                       |
| 系统时间错误                    | 以交易日历和 Tushare 返回的数据为准，不会写入未来日期的数据                                |
| 同时打开两个 App 实例           | 已有 single-instance 插件 + sidecar 加锁，不会重复运行                                     |

## 12. 设置（金融指标分区）

- **Tushare token**：密码框 +「保存」「测试连接」「清除」。已保存时只显示「已设置（尾号 ab12）」。「测试连接」调用 `finance_verify`，用 `trade_cal` 和 `adj_factor`（2000 积分门槛）各请求 1 行，显示「连接正常，积分满足要求」或具体错误。
- 「Tushare 失败时使用 AKShare 备用源」开关。
- 数据状态：最早和最新日期、finance.db 大小、「打开数据文件夹」。
- 「重建金融数据」（危险操作，二次确认）。
- 首次保存 token 后弹窗确认首次回补：「需要下载个股 2015 年至今、指数估值 2005 年至今的数据，约 6000–8700 次请求，预计 35–50 分钟。期间可以正常使用，关掉 App 下次会继续。」[开始] [稍后]。

## 13. v1 不做

服务器部署和 HTTP 数据源（只预留接口）、App 运行期间定时更新、分钟和盘中实时数据、个股或行业页面、导出 CSV 和图片、自定义公式指标、阈值同步、在手机上查看、Windows 系统通知、把指标放进「今天」页。

## 14. 验收标准

1. **token**：在设置填写后，Windows「凭据管理器」里能看到 `com.royce.workbench.finance` 条目；workbench.db、finance.db 和日志里都搜不到 token 原文；用任务管理器查看 sidecar 的命令行，也看不到 token。填错 token →「测试连接」显示「token 无效」。
2. **首次回补**：确认后状态栏显示阶段和进度。几分钟内估值页和另外两个指标的**最新值**先出来。中途退出 App 再打开，进度从断点继续，没有重复或缺漏（`dataset_status` 中每个交易日恰好一条 `ok`）。完整回补 ≤ 60 分钟，全程没有出现 Tushare 限流导致的失败。
3. **增量更新**：第二天打开 App 后，只请求新增的交易日（`run_log` 中调用次数 ≤ 20）。19:00 前打开时，估值数据只补到前一个交易日，并提示「今日数据尚未发布」。App 在托盘常驻期间不会自行更新。
4. **口径**：2026-11-05 的前 5% 成交额占比 = **44.2%**（沪深，N=5217，k=261），与 §5.1 的实测对照值误差 < 0.05 个百分点。2026-11-05 的沪深300 PE-TTM 原值 = 13.59，PB = 1.34，创业板指 PE-TTM = 29.10。随机抽 3 天的 60 日新高占比，与在 Python 里手工按口径计算的结果一致。
5. **图表**：左列分组和最新值正确；指标 1 的日线 / 月均切换正确；沪深300 叠加开关生效，并在重启后保持；阈值虚线位置正确；范围缩放条和 1 年 / 3 年 / 5 年 / 全部快捷键都能用；估值页的指数、PE-TTM / PB、5 年 / 10 年 / 全部、分位 / 原始值切换都正确，5 年分位约 2009 年中以前为空、10 年分位约 2014 年以前为空，三个窗口的曲线明显不同；估值原始值从 2005 年开始；深色主题下图表可读。
6. **阈值**：首次自动写入 §7.1 的 9 条默认阈值；可以修改、停用、删除和新增；删掉的默认阈值重启后不会再出现。
7. **提醒**：用测试数据让某个指标从 44% 升到 46% → 弹出 1 条软件内通知条，提醒页里出现带「金融」标记的提醒；第二天仍是 46.5% → 不再提醒；回落到 43.5%（低于阈值减回差）后再升到 45.5% → 再提醒 1 次。补算 5 天、期间发生越线 → 只提醒 1 次。同一次更新中 3 条以上越线 → 合并为 1 条。首次回补完成后不弹历史提醒。
8. **离线**：断网打开 App，图表照常显示，状态栏提示离线，不崩溃，不出现无限重试。
9. **测试与 CI**：`pnpm lint / typecheck / test` 全绿；新增 Python 任务（ruff + pytest + PyInstaller 打包后运行 `finance-engine --version`）全绿；CI 总时长增加 ≤ 5 分钟。
10. **安装包**：正式安装版中，sidecar 能被正常调用；安装包体积增加量写进 PR 描述（目标：不含 AKShare 时 ≤ 80 MB）。

## 15. 测试计划

**Python（pytest，不联网）**

- 指标计算（合成数据）：
  - 前 5%：N 不能被 20 整除时的 `ceil`、成交额相同时的排序、停牌股被排除、北交所被排除。
  - 60 日新高：除权日前后（复权因子变化）不出现假新高或假新低；新股满 60 天前后；窗口内交易天数恰好 44 天和 45 天；平高也算新高；长期停牌后复牌。
  - 估值分位：不使用未来数据；三个窗口的起点；窗口不足时为空；PE ≤ 0 被跳过；一组已知序列的分位与手算结果一致。
- Tushare 客户端（`respx` 模拟）：字段映射；`has_more` 和 6000 行翻页；40101 映射为 `TOKEN_INVALID`；限流后退避重试；超时；字段缺失映射为 `UPSTREAM_SCHEMA`；日志中 token 被打码。
- planner：给定 `dataset_status` 和当前时间，生成的待办日期正确（包括 19:00 前后、周末、节假日、`pending` 的重试）。
- 断点续传：在第 N 天模拟异常退出 → 重跑 → 结果与一次跑完完全一致（比较 `indicator_values` 的哈希）。
- 协议：stdout 只输出合法的 NDJSON，事件结构有 JSON Schema 校验；stdin 未提供 token 时输出 `TOKEN_MISSING`。
- 可选的联网冒烟测试（`pytest -m live`，需要环境变量提供 token，CI 默认跳过）：拉 2026-11-05 一天，校验 §14 第 4 条的对照值。

**TypeScript（Vitest）**

- `threshold-evaluator`：越线、回差、首次静默、阈值修改后重置、多天补算只提醒 1 次、重算日期不重复提醒、合并规则。
- 仓库：`finance_thresholds` 和 `finance_alert_states` 的增删改查、默认阈值写入是幂等的、提醒和状态在同一事务中写入（失败时整体回滚）。
- `monthly.ts`、`chart-option.ts` 的快照测试；引擎事件的 zod 解析（非法行被忽略并记录日志）。
- `LocalSidecarSource` 用假的 Rust invoke 和事件测试状态机：运行中、完成、失败、重复启动。

**Rust**

- `finance_*` 命令拒绝非 main 窗口；sidecar 启动参数中不包含 token（单测断言构造出的参数列表）。

**手动测试**（写进 `docs/finance-verification.md`）：§14 的第 1、2、3、5、7、8、10 条。

## 16. 决定记录与实现时实测项

### 16.1 已确认的决定（Royce，2026-11-07）

| #   | 问题                                      | 决定                                                                                                                                                                               |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 股票池是否含北交所                        | **不含**，只算沪深 A 股。2026-11-05 前 5% 占比的对照值为 **44.2%**                                                                                                                 |
| 2   | 60 日新高分母                             | **只算符合条件的股票**（上市满 60 个交易日，窗口内交易 ≥ 45 天）                                                                                                                   |
| 3   | 60 日新高默认阈值                         | **高于 20% / 低于 3%**；首次回补后列出历史分布，再决定是否校准                                                                                                                     |
| 4   | 估值指标                                  | **只用 PE-TTM + PB**，不展示静态 PE                                                                                                                                                |
| 5   | 估值历史起点                              | **`index_dailybasic` 单独从 2005 年开始拉**；个股日线仍从 2015 年开始。5 年 / 10 年 / 全部分位因此各不相同                                                                         |
| 6   | 原始日线保留                              | **全部保留**                                                                                                                                                                       |
| 7   | 托盘重开或进入金融页时是否自动更新        | **不自动**，只在 App 启动时更新 + 手动「立即更新」                                                                                                                                 |
| 8   | 金融提醒是否进提醒列表                    | **进**，可以像普通提醒一样勾选完成                                                                                                                                                 |
| 9   | 沪深300 估值的风险                        | **v1 接受**；Tushare 停止提供时按 §11 显示「数据源暂不可用」，备选来源见 §4.3（中证官网估值，或用成分股自己算）                                                                    |
| 10  | AKShare 是否打包                          | **PR-F5 先实测安装包增加量**，再由 Royce 决定                                                                                                                                      |
| 11  | 前 5% 指标默认视图                        | **日线**（月均作为可切换视图）。与参考图和草案原先的默认值（月均）不同                                                                                                             |
| 12  | 删除的阈值是否显示在回收站                | **v1 不显示**                                                                                                                                                                      |
| 13  | 新依赖                                    | **全部同意**：前端 `echarts`；Rust `keyring`、`tauri-plugin-shell`；Python 工具链 `uv`、`httpx`、`pandas`、`numpy`、`pyinstaller`、`pytest`、`respx`、`ruff`，可选 `akshare`       |
| 14  | 开发环境                                  | Royce 的电脑需要 **Python 3.12 + uv**，由 Codex 在 PR-F1 开始时检查，缺少就安装（Royce 已把安装工作交给 Codex）                                                                    |
| 15  | 交易日历起点                              | **从 2005 年开始**拉取，覆盖估值所需；个股日线仍从 2015 年开始                                                                                                                     |
| 16  | 最新结果分阶段发布                        | **index、recent 阶段完成后先计算并发布最新结果**，完整历史回补后再统一补算历史；不得将最新值覆盖成更旧或错误的结果                                                                 |
| 17  | 复权因子缺失                              | **保留日线，受影响交易日的 60 日新高结果标为未就绪并在下次重试**；不得悄悄排除股票改变分母                                                                                         |
| 18  | 离线或首个请求失败                        | **只写 run_log**；行情、指标和完成标记保持不变                                                                                                                                     |
| 19  | 历史旧新代码数值冲突（Royce，2026-11-08） | **按当日正式有效代码取日线和复权因子**：变更前用旧代码，变更后用新代码；忽略未生效或已失效代码的回写。保持同一证券身份和原始上市日，不重复计数；有效代码缺失仍报错，不猜测替代数据 |

### 16.2 🔬 实现时实测（Codex 自行确认，结果写进对应 PR 的文档，不需要 Royce 决定）

1. **`daily` 的分页**（PR-F1）：是否支持 `offset` / `limit`。不支持时，改为按交易所拆分请求，或者按 `ts_code` 列表分批请求，保证单日超过 6000 行时不丢数据。
2. **Tushare 错误码**（PR-F1）：「积分不足」「限流」实际返回的 `code` 和 `msg`。据此完善 §8.3 的错误映射，原始返回值写进 `run_log`。
3. **`tauri-plugin-sql` 能否用绝对路径**（PR-F2）：能否加载 `%LOCALAPPDATA%\com.royce.workbench\finance.db`。不能就和 `workbench.db` 放在同一目录，并在文档里说明原因。
4. **实测数据**（PR-F1）：`finance.db` 实际体积、首次回补耗时、`index_dailybasic` 从 2005 年起拉三个指数各需几次调用。

## 17. 建议的 PR 拆分

每个 PR 单独一个分支，CI 全绿后 squash 合并，顺序如下：

| PR             | 分支                   | 内容                                                                                                                                                                                                                                                                                                                   | 不包含                  |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **F1**         | `feat/finance-engine`  | 先检查并安装 Python 3.12 + uv；`engines/finance/` 全部：finance.db schema、Tushare 客户端（限速、翻页、错误映射）、6 个数据集、3 个指标、planner、断点续传、NDJSON 协议、命令行、pytest；CI 增加 Python 任务；`docs/finance-engine.md`（包括在命令行用 stdin 输入 token 手动跑一次的步骤，以及实测的库体积和回补耗时） | App 端任何改动；AKShare |
| **F2**         | `feat/finance-sidecar` | PyInstaller 打包脚本、`externalBin`、`finance.rs`（keyring token、启动和取消 sidecar、事件转发、verify）、`LocalSidecarSource`、启动时触发更新、设置页「金融指标」分区（token、测试连接、重建、数据状态）、首次回补确认弹窗、侧边栏入口和占位页 + 状态栏                                                               | 图表；阈值              |
| **F3**         | `feat/finance-ui`      | `workbenches/finance` 左列 + 指标页、ECharts 图表（双轴、阈值线先显示默认值、缩放、范围快捷键）、日线 / 月均、估值各项切换、说明区、懒加载、深色主题、截图                                                                                                                                                             | 阈值编辑和提醒          |
| **F4**         | `feat/finance-alerts`  | `0003_finance.sql`、阈值仓库、默认阈值写入、阈值面板（增删改停用）、`threshold-evaluator`、写入提醒（同一事务）、合并规则、提醒页「金融」标记、点通知跳转到指标页；`docs/finance-verification.md` 完整验收表                                                                                                           | —                       |
| **F5**（可选） | `feat/finance-akshare` | AKShare 备用源（日历、沪深300 收盘、当天成交额快照）、设置开关、来源标注、体积实测                                                                                                                                                                                                                                     | —                       |

> 给 Codex 的提示词见 `docs/specs/finance-codex-prompts.md`（含新对话用的「背景交接」）。一次只发一个，上一个 PR 合并并 `git checkout main && git pull` 之后再发下一个。
