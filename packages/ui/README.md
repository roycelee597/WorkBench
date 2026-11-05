# @workbench/ui

共享 Button、Dialog 和 cn 工具，供桌面 Shell 与综合工作台使用；主题变量及 Tailwind CSS 入口位于 apps/desktop/src/styles.css。组件遵循仓库 PascalCase 文件命名。

组件源码参考 [shadcn/ui](https://github.com/shadcn-ui/ui)，使用 Radix 的交互基础，保留可访问标签、焦点圈定和 Esc 关闭。来源许可证见 [LICENSE.shadcn](LICENSE.shadcn)。components.json 记录样式与共享包别名。

在仓库根目录运行 pnpm --filter @workbench/ui typecheck 检查本包类型。
