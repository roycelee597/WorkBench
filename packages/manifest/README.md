# @workbench/manifest

用 zod 校验本地模块的 `manifest.json`。从 JSON 解析出未知值后，
调用 `validateManifest(value)` 获取经过校验的 `ModuleManifest`，或使用
`manifestSchema.safeParse(value)` 读取结构化校验结果。

在仓库根目录运行 `pnpm --filter @workbench/manifest typecheck` 可检查本包类型。
