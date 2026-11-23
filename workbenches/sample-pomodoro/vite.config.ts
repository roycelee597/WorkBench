import { defineConfig } from "vite";

// 不透明 iframe 中使用经典脚本入口，避免对 ES 模块请求跨域授权。
export default defineConfig({
  base: "./",
  build: {
    lib: {
      entry: "src/main.ts",
      name: "WorkBenchPomodoro",
      formats: ["iife"],
      fileName: () => "pomodoro.js",
      cssFileName: "pomodoro",
    },
  },
});
