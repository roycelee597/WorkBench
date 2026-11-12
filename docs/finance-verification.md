# 金融指标工作台验收

F4 在 Windows 上使用独立的 Tauri 应用标识 `com.royce.workbench.f4-smoke` 和独立的应用目录，真实运行迁移、SQLite 写入、提醒调度、窗口唤起与通知跳转。行情与引擎完成事件使用合成数据，隔离实例没有配置 Tushare 凭据。

2026-11-12 完成最终隔离验收。五日序列的累计提醒数为 **0、1、1、1、2**，通知正文跳转、通知完成、阈值新增／编辑／停用／删除和离线缓存显示均通过。默认阈值删除后的重启保持行为也已验证。本地 **170 个 Vitest** 与 **59 个离线 pytest** 通过，lint、typecheck、Prettier、Ruff 和 Rust 格式检查通过。

## 规格 §14 验收表

| 项  | 验收标准                                                                          | 结果与证据                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 凭据管理器保存 token，数据库、日志、进程参数不泄露，错误凭据有提示                | 沿用 F2 凭据与错误提示实测和 F3 打包引擎脱敏实测。本轮阈值验收使用空凭据。见[凭据与 sidecar 验证](finance-sidecar-verification.md)和[打包引擎实测](finance-ui-verification.md#windows-tauri-与打包-sidecar-冒烟实测)。                                                     |
| 2   | 首次回补提前显示最新值，可退出续传，无缺漏，累计不超过 60 分钟                    | 沿用 F1 联网实测。累计执行 **34 分 25 秒**，包含一次续传，2,877 个个股交易日无缺口。F4 自动测试另外验证首次历史评估及全量重建静默。见[完整回补记录](finance-engine.md#完整历史断点续传与增量结果)。                                                                        |
| 3   | 启动时增量更新，第二天 ≤20 次请求，19:00 前按已发布交易日处理，托盘常驻不定时更新 | F1 实测重复增量为 **14 次**请求。交易日边界和仅启动后触发一次由 planner 及启动定时器自动测试覆盖。                                                                                                                                                                         |
| 4   | 前 5% 与估值对照值正确，随机三天新高占比与独立计算一致                            | 沿用 F1 实测。2026-11-05 前 5% 为 **44.2%**（N=5,217，k=261），沪深300 PE-TTM／PB 为 **13.59／1.34**，创业板 PE-TTM 为 **29.10**。三天独立新高计算与缓存一致。见[联网实测](finance-engine.md#联网实测与记录)。                                                             |
| 5   | 分组目录、月均、叠加、虚线、时间范围与估值切换、深色主题                          | 沿用 [F3 图表验收](finance-ui-verification.md)。F4 额外在 Windows 实测虚线取启用的阈值，目录和卡片显示越线标记。                                                                                                                                                           |
| 6   | 初始化九条默认值，支持新增、编辑、停用和删除，删除后重启不补回                    | 通过。内存 SQLite 验证幂等、删除记录及状态软删除。隔离 Windows 实例实测新增、修改、停用、删除，删除一条默认值后重启仍为八条。                                                                                                                                              |
| 7   | 越线、回差、补算、合并提醒，托盘唤起、金融标记、完成与通知跳转                    | 通过。Windows 实测五日序列、隐藏窗口唤起、跳转和完成。内存 SQLite 与调度器测试覆盖多日补算、两条分别通知、三条合并、重算跳过、回滚与重试。                                                                                                                                 |
| 8   | 离线仍显示缓存图表，报告网络错误，有限重试                                        | Windows 实测注入网络失败事件后缓存图表仍显示。Python 自动测试覆盖实际 HTTP 重试上限和失败时保持缓存。                                                                                                                                                                      |
| 9   | lint／typecheck／test 与 Windows CI、Python 检查和打包版本冒烟通过                | 本地离线检查通过。Windows CI 包含冻结依赖、前端检查、Python 检查、PyInstaller 版本冒烟和桌面编译，远程结果见 PR 检查。                                                                                                                                                     |
| 10  | Windows 安装包包含可调用的 sidecar，记录体积增量                                  | F2 同主程序对照测得 sidecar 增量 **34.84 MiB**，F3 在隔离 Windows Tauri 中已验证实际打包引擎可调用。F4 的 NSIS 验证包为 **38.13 MiB**，完整性检查通过且含 `finance-engine.exe`，调用行为沿用 F3 实机记录。见[体积对照](finance-sidecar-verification.md#windows-x64-体积)。 |

## 复现 F4 越线

1. 在仓库根目录的 PowerShell 运行下面的命令。第一行模拟完整的五日序列并断言实际 SQLite 和提醒调度行为，第二行复现混合证券组的疑似换码提示。测试都使用临时数据，无需 token。

   ```powershell
   pnpm exec vitest run apps/desktop/tests/finance-alerts.test.ts
   uv run --project engines/finance --locked pytest engines/finance/tests/test_engine_protocol.py -k known_bj_quote_match
   ```

2. 桌面检查先按下文「准备手动测试缓存」启动隔离实例。每次更新把新日期填入合成 `finance://event` 的 `done.new_dates`、`through`，随后发出正常 `engine_exit`。该方法走应用中的真实完成事件监听与提醒事务。
3. 打开金融工作台，用 **44%** 建立基线。前 5% 指标应出现高于 45%、回差 1 个百分点的默认阈值，首次无通知。关闭主窗口使它隐藏到托盘。依次发布 **46%、46.5%、43.5%、45.5%**，累计提醒数应依次为 **1、1、1、2**。第一次越线应先唤起主窗口，再显示右上角通知。
4. 点通知主体，应打开对应指标。目录与卡片应显示「已高于阈值」。到综合工作台的「提醒事项」查看「金融」标记，用通知或提醒列表完成一条。合并提醒打开正文中列出的第一条指标序列，所有越线项仍在正文中。
5. 在阈值面板新增 49%、回差 2 的阈值，改到 48% 后停用，确认停用的线不显示。删除 45% 默认项并重启隔离实例，默认总数仍为八条，删除项不出现在回收站。若正式版仍在运行，可为隔离实例设置不同的全局快捷键。

### 准备手动测试缓存

在仓库根目录的 PowerShell 执行以下命令。目录已存在时会停止，避免复用先前测试的提醒与阈值状态。若需要再跑一遍，先为测试目录换一个名称，并同步修改下方的路径。

```powershell
$financeCheckRoot = Join-Path (Get-Location) 'engines/finance/dist/f4-manual'
if (Test-Path -LiteralPath $financeCheckRoot) { throw '测试目录已存在，请另选一个测试目录' }
$financeCheckApp = (New-Item -ItemType Directory -Path (Join-Path $financeCheckRoot 'app')).FullName
@{
  identifier = 'com.royce.workbench.f4-manual'
  app = @{ appDirectoriesOverride = $financeCheckApp }
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $financeCheckRoot 'tauri.json') -Encoding utf8
@'
import json
import sys
from pathlib import Path
from finance_engine.db import Database, timestamp
from finance_engine.engine import INDICATORS

path = Path(__file__).resolve().parent / "app/finance.db"
db = Database(path)
with db.conn:
    for indicator in INDICATORS:
        db.conn.execute(
            "INSERT OR REPLACE INTO indicator_meta VALUES (?,?,?)",
            (indicator.id, json.dumps(indicator.meta(), ensure_ascii=False), timestamp()),
        )
    day, value = int(sys.argv[1]), float(sys.argv[2])
    db.conn.execute("INSERT OR REPLACE INTO trade_calendar VALUES (?,1)", (day,))
    db.conn.execute(
        "INSERT OR REPLACE INTO indicator_values VALUES (?,?,?,?,?,?)",
        ("top5_turnover_share", day, value, None, timestamp(), "0.1.0"),
    )
db.close()
'@ | Set-Content (Join-Path $financeCheckRoot 'sample.py') -Encoding utf8
uv run --project engines/finance --locked python "$financeCheckRoot/sample.py" 20261102 44
pnpm --filter desktop tauri dev --config "$financeCheckRoot/tauri.json"
```

打开金融工作台，等待 44% 和九条默认阈值出现。使用 `Ctrl+Shift+I` 打开该开发实例的开发者工具，在 Console 输入以下函数。

```javascript
async function publishFinanceSample(day) {
  const key = "top5_turnover_share";
  const emit = (payload) =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
      target: { kind: "AnyLabel", label: "main" },
      event: "finance://event",
      payload: JSON.stringify(payload),
    });
  await emit({ type: "hello", engine_version: "0.1.0", schema_version: 1 });
  await emit({ type: "indicator_updated", indicator: key, through: String(day) });
  await emit({
    type: "done",
    status: "ok",
    new_dates: { [key]: [String(day)] },
    through: { [key]: String(day) },
  });
  await emit({ type: "engine_exit", code: 0, cancelled: false });
}
```

另开一个 PowerShell 并进入仓库根目录。每次先在这个窗口写入一天，再在开发者工具中调用对应日期。例如第一天先执行下面的命令，再调用 `await publishFinanceSample(20261103)`。后续三天分别用 `20261104 46.5`、`20261105 43.5` 和 `20261106 45.5`，每写一天就发布对应日期。每次等待通知或图表刷新完成后再继续。

```powershell
uv run --project engines/finance --locked python engines/finance/dist/f4-manual/sample.py 20261103 46
```

检查托盘唤起时，可在写入 46% 以后、发布事件以前关闭主窗口。开发者工具保持打开，调用发布函数后检查主窗口是否出现。完成后从隔离实例的托盘菜单退出，并在启动它的 PowerShell 中按 `Ctrl+C`。

## 60 日新高历史分布

F1 实测覆盖 2,818 个有效交易日。P5 为 **0.472441%**，P50 为 **3.618862%**，P95 为 **14.355466%**。本次默认值继续采用高于 20% 和低于 3%。[F1 测量记录](finance-engine.md#联网实测与记录)

## 实现约定

- 每次成功或部分完成的引擎运行，在正常退出后处理 `done.new_dates`。首次状态、变更数值／方向／回差、重新启用和全量重建均静默建立基线。只改备注会保留回差状态。
- 提醒、评估状态和跳转目标一起写入 `execute_batch`。发生回滚时保留待处理的完成事件，下次读取或更新前重试。
- 跳转目标放在金融工作台的 `workbench_kv` 中，以提醒 ID 为键。这样较早的通知在阈值修改或删除后仍能打开原指标。三条及以上合并提醒打开正文第一项的指标序列。
- 混合换码回归使用同一天价格、成交额完全相同的两只沪深证券和一只北交所证券。沪深配对保留 `POSSIBLE_CODE_CHANGE` 提示，涉及北交所的匹配另写日志。

## Windows 隔离实例截图

- [阈值面板、越线标记和停用状态](screenshots/finance-f4-thresholds.png)
- [从隐藏窗口唤起后的软件内通知](screenshots/finance-f4-notice.png)
- [提醒事项中的金融标记](screenshots/finance-f4-reminders.png)
