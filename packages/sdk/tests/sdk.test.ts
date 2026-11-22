import { describe, expect, it, vi } from "vitest";
import {
  createWorkbenchSdk,
  MODULE_PROTOCOL,
  WorkbenchError,
  type ModuleRequest,
  type ModuleSubscription,
} from "../src/index";

function transport() {
  const sent: {
    message: ModuleRequest | ModuleSubscription;
    port: MessagePort;
  }[] = [];
  const wb = createWorkbenchSdk({
    channel: "synthetic-frame",
    timeoutMs: 2_000,
    send: (message, port) => sent.push({ message, port }),
  });
  return { wb, sent };
}

describe("模块 SDK", () => {
  it("给并发请求各自的 ID 和端口，忽略 ID 不符的回应", async () => {
    const { wb, sent } = transport();
    const first = wb.storage.get("counter");
    const second = wb.engine.start({ input: { check: true }, paths: ["synthetic-handle"] });
    const { message: read, port: readPort } = sent[0]!;
    const { message: start, port: startPort } = sent[1]!;
    expect(read).toMatchObject({
      protocol: MODULE_PROTOCOL,
      channel: "synthetic-frame",
      method: "storage.get",
      params: { key: "counter" },
    });
    expect(start).toMatchObject({
      method: "engine.start",
      params: { input: { check: true }, paths: ["synthetic-handle"] },
    });
    if (read.kind !== "request" || start.kind !== "request") throw new Error("需要请求消息");
    expect(read.id).not.toBe(start.id);
    const reply = (id: string, value: unknown) => ({
      protocol: MODULE_PROTOCOL,
      kind: "response",
      id,
      ok: true,
      value,
    });
    readPort.postMessage(reply(start.id, "错误端口"));
    startPort.postMessage(reply(start.id, { taskId: "task-1" }));
    readPort.postMessage(reply(read.id, 4));
    await expect(second).resolves.toEqual({ taskId: "task-1" });
    await expect(first).resolves.toBe(4);
    wb.dispose();
  });

  it("保留宿主拒绝通知权限时的错误代码", async () => {
    const { wb, sent } = transport();
    const pending = wb.notifications.send({ title: "无权限测试", body: "合成内容" });
    const { message, port } = sent[0]!;
    if (message.kind !== "request") throw new Error("需要请求消息");
    port.postMessage({
      protocol: MODULE_PROTOCOL,
      kind: "response",
      id: message.id,
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "没有通知权限" },
    });
    await expect(pending).rejects.toBeInstanceOf(WorkbenchError);
    await expect(pending).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: "没有通知权限",
    });
    wb.dispose();
  });

  it("区分超时与主动断开", async () => {
    vi.useFakeTimers();
    try {
      const { wb, sent } = transport();
      const timeout = expect(wb.storage.get("counter")).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(2_000);
      await timeout;
      const aborted = expect(wb.app.getInfo()).rejects.toMatchObject({ code: "DISCONNECTED" });
      wb.dispose();
      await aborted;
      for (const { port } of sent) port.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("用同一事件端口订阅并能单独取消", async () => {
    const { wb, sent } = transport();
    const receiveTheme = vi.fn();
    const stopTheme = wb.app.onThemeChange(receiveTheme);
    let stopData = () => {};
    const changed = new Promise<{ domain: string }>((resolve) => {
      stopData = wb.events.on("data-changed", resolve);
    });
    expect(sent).toHaveLength(1);
    const { message, port } = sent[0]!;
    expect(message).toEqual({
      protocol: MODULE_PROTOCOL,
      kind: "subscribe",
      channel: "synthetic-frame",
    });
    stopTheme();
    port.postMessage({
      protocol: MODULE_PROTOCOL,
      kind: "event",
      event: "theme-changed",
      value: "dark",
    });
    port.postMessage({
      protocol: MODULE_PROTOCOL,
      kind: "event",
      event: "data-changed",
      value: { domain: "memos" },
    });
    await expect(changed).resolves.toEqual({ domain: "memos" });
    expect(receiveTheme).not.toHaveBeenCalled();
    stopData();
    wb.dispose();
    port.close();
  });
});
