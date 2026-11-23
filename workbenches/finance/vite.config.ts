import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // 库模式默认保留 process.env。金融包运行在浏览器 iframe 中，没有 Node 全局对象。
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    lib: {
      entry: "src/main.tsx",
      name: "WorkBenchFinance",
      formats: ["iife"],
      fileName: () => "finance.js",
      cssFileName: "finance",
    },
  },
});
