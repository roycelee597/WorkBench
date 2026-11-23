# @workbench/sdk

模块在 iframe 中使用 `createWorkbenchSdk()` 连接宿主。API 包括存储、通知、日程、
提醒、备忘、文件选择以及可选引擎任务。调用失败会抛出带 `code` 的 `WorkbenchError`。
事件订阅返回取消函数，页面结束时可调用 `wb.dispose()` 释放连接。

接口见 [架构 §6.2](../../ARCHITECTURE.md#62-sdk-api)，示例见 [模块开发指南](../../docs/plugin-guide.md)。

在仓库根目录运行 `pnpm --filter @workbench/sdk typecheck` 可检查本包类型。
