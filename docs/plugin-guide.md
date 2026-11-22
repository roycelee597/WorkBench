# 开发 WorkBench 模块

模块由宿主加载静态前端，通过 `@workbench/sdk` 请求宿主能力。番茄钟示例展示了最小的本地模块，包含计时、设置存储和软件内通知。接口及权限见 [架构 §6](../ARCHITECTURE.md#6-模块运行时) 和 [模块运行时规格](specs/module-runtime.md)。

## 写一个前端模块

1. 复制 `workbenches/sample-pomodoro` 的目录结构，修改 `package.json` 的包名和 `public/manifest.json` 的模块 ID、名称、版本及权限。模块 ID 使用自己维护的反向域名，例如 `com.example.focus`。
2. 在入口 HTML 中，用相对路径引入打包好的经典脚本和样式。示例用 Vite 的 IIFE 输出，适用于不透明来源的沙盒 iframe。入口在 ZIP 根目录的 `manifest.json` 中声明，路径示例为 `index.html` 或 `ui/index.html`。
3. 在 TypeScript 中导入 SDK。用 `storage` 保存模块自己的 JSON 数据。要发送软件内通知，在 manifest 加上 `notifications` 并由用户在安装时同意。

```ts
import { createWorkbenchSdk, WorkbenchError } from "@workbench/sdk";

const wb = createWorkbenchSdk();

export async function saveAndNotify(minutes: number) {
  try {
    await wb.storage.set("focus-minutes", minutes);
    await wb.notifications.send({ title: "专注时间已保存", body: `${minutes} 分钟` });
  } catch (error) {
    if (error instanceof WorkbenchError && error.code === "PERMISSION_DENIED") {
      return "请到 WorkBench 设置检查模块权限。";
    }
    throw error;
  }
  return "已保存";
}

window.addEventListener("pagehide", () => wb.dispose());
```

SDK 的异步调用可能因权限撤销、超时或宿主限流而失败。按 `WorkbenchError.code` 处理这些情况。单个模块最多存储 10 MiB JSON，模块数据在卸载时清除。静态资源随包携带，模块对话框、存储和通知都走宿主。

## 打包并安装

在 Windows 的仓库根目录运行以下命令构建并打包示例：

```powershell
pnpm --filter @workbench/sample-pomodoro run package
```

脚本将 `dist` 内的文件压成 ZIP，并将扩展名改为 `.wbpkg`。用其他打包工具时，将 `manifest.json` 和前端文件放进 ZIP 根目录，使用常规 ZIP 压缩。包内路径使用普通 ASCII 文件名和正斜线，超过 2,048 条归档条目或解压超过 256 MiB 的包会被拒绝。

打开 WorkBench 的「设置 → 模块管理 → 安装本地 .wbpkg」，选择 `workbenches/sample-pomodoro/sample-pomodoro.wbpkg`，核对模块与权限后点击「同意并安装」。

## 在隔离实例验证安装、权限和卸载

在仓库根目录用 PowerShell 运行。使用独立 identifier 和数据目录，里面只放合成测试数据。复测时可更换两者的后缀。

```powershell
$moduleCheck = Join-Path (Get-Location) 'dist/module-runtime-check'
if (Test-Path -LiteralPath $moduleCheck) { throw '请使用新的隔离目录和 identifier' }
$moduleCheckData = (New-Item -ItemType Directory -Path (Join-Path $moduleCheck 'app') -Force).FullName
@{
  identifier = 'com.royce.workbench.module-runtime-check'
  app = @{
    appDirectoriesOverride = $moduleCheckData
    windows = @(@{ label = 'main'; title = 'WorkBench 模块验收（隔离）'; width = 1280; height = 900 })
  }
} | ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath (Join-Path $moduleCheck 'tauri.json') -Encoding utf8
pnpm --filter desktop tauri dev --config ../../dist/module-runtime-check/tauri.json
```

1. 安装示例包，进入侧栏「番茄钟」。把「专注时长（分钟）」改成 1 并点击「保存」，切回番茄钟后核对已记住时长。点击「测试通知」，应看到软件内通知。
2. 回到「设置 → 模块管理」，找到番茄钟下「显示软件内通知」，点击同行的「撤销」，再点击「撤销权限」。从侧栏打开番茄钟，点击「测试通知」，应看到 `PERMISSION_DENIED`，并且没有新的软件内通知。
3. 打开模块管理，点击番茄钟的「卸载」，核对将删除的内容后点击「彻底卸载」。侧栏和已安装列表都应移除番茄钟。检查隔离目录的 `app/modules`，确认 `com.royce.pomodoro` 目录及该 ID 的清理记录均已移除。重新安装同一示例时，计时应回到默认 25 分钟。
4. 综合工作台在模块管理中只有「隐藏入口」和「显示入口」操作。隐藏后侧栏移除入口，再显示时可重新访问综合工作台。

## 可选 Windows 引擎

声明 `engine.path`、`engine.sha256` 及 `engine.concurrency` 并申请 `engine` 权限。用 `Get-FileHash -Algorithm SHA256` 计算打包的 EXE 摘要。宿主在安装和启动前校验摘要。安装确认会标明引擎拥有当前 Windows 用户的操作系统权限，因此请只运行可信作者提供的引擎。

启动时引擎通过 stdin 读取一条 JSON。stdout 每行输出一个带 `type` 的 JSON 对象，失败先报告 `error` 再退出。用 `wb.engine.start` 返回的 `taskId` 读取进度、日志或取消任务。访问用户选中的文件先申请 `dialog.open`，将宿主返回的句柄放入 `paths`。将该路径交给引擎作为执行目标还需申请 `engine.exec_paths` 并取得当次用户确认。

清理声明只描述模块自己的凭据、私有数据表和设置前缀。禁止在示例、测试包或日志中写入真实密钥，测试包要在隔离的 WorkBench 实例中安装。
