// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createWorkbenchSdk, MODULE_CHANNEL_PARAM } from "@workbench/sdk";
import { ModuleLoader } from "../src/runtime/ModuleLoader";
import type { ModuleRecord } from "../src/runtime/module-api";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("用 iframe 的真实窗口接收 SDK 请求，并按最新授权回复", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onBadge = vi.fn();
  const record: ModuleRecord = {
    manifest: {
      id: "com.example.pomodoro",
      name: "番茄钟测试",
      version: "1.0.0",
      entry: "index.html",
      minHostVersion: "0.1.0",
      permissions: ["notifications"],
    },
    grants: ["notifications"],
    url: "http://wbpkg.localhost/com.example.pomodoro/synthetic-route/index.html",
  };

  try {
    await act(async () => root.render(<ModuleLoader record={record} onBadge={onBadge} />));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const source = frame.contentWindow!;
    expect(source).not.toBeNull();
    const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      MODULE_CHANNEL_PARAM,
    )!;
    const sdk = createWorkbenchSdk({
      channel,
      timeoutMs: 1_000,
      send: (data, port) =>
        window.dispatchEvent(
          new MessageEvent("message", { origin: "null", source, data, ports: [port] }),
        ),
    });
    try {
      await act(async () => {
        await sdk.notifications.send({ title: "番茄钟", body: "第一次合成通知" });
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("第一次合成通知");
      expect(invoke).toHaveBeenCalledExactlyOnceWith("show_main");

      await act(async () =>
        root.render(<ModuleLoader record={{ ...record, grants: [] }} onBadge={onBadge} />),
      );
      await expect(
        sdk.notifications.send({ title: "番茄钟", body: "撤销授权后的合成通知" }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("撤销授权后的合成通知");
    } finally {
      sdk.dispose();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
