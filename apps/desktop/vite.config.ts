import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // 保留 Rust 的编译错误，便于在同一终端排查。
  clearScreen: false,
  server: {
    // Tauri 使用固定端口，端口被占用时直接报错。
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: "ws" as const, host, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
