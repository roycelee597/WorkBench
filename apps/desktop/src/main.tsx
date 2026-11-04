import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeDataLayer } from "./core/repositories/initialize";

void initializeDataLayer().catch((error: unknown) => console.error("初始化本地数据库失败", error));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
