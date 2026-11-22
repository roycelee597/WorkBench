# 番茄钟示例模块

通过 WorkBench SDK 保存专注时长，在计时结束时发送软件内通知。源码使用浏览器界面和计时 API，宿主操作通过 `@workbench/sdk`。

在仓库根目录运行：

```powershell
pnpm --filter @workbench/sample-pomodoro run package
```

生成 `workbenches/sample-pomodoro/sample-pomodoro.wbpkg`。在 WorkBench 的「设置 → 模块管理」里选择该文件安装。
