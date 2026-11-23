import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MODULE_PROTOCOL, type ModuleErrorCode } from "@workbench/sdk";
import { method, ModuleBridge, ModuleRateLimiter } from "../src/runtime/bridge";

const channel = "83e97d4f-4272-4c6a-bdbf-54de2df713bb";
const otherChannel = "5fc43d41-a0a9-4f94-9845-71d48a85d6ac";

function fixture() {
  const frame = {} as Window;
  const otherFrame = {} as Window;
  const permissions = ["notifications", "calendar:read"];
  const send = vi.fn();
  const params = { title: "番茄钟结束" };
  const bridge = new ModuleBridge({
    source: () => frame,
    channel,
    permissions: () => permissions,
    limiter: new ModuleRateLimiter(() => 100),
    methods: {
      "notifications.send": method(
        z.strictObject({ title: z.string() }),
        "notice",
        send,
        "notifications",
      ),
    },
  });

  function packet(
    request: Partial<{
      origin: string;
      source: Window;
      channel: string;
      params: unknown;
      method: string;
    }> = {},
  ) {
    const callbacks = { postMessage: vi.fn(), close: vi.fn() };
    const { source = frame, origin = "null", ...fields } = request;
    const promise = bridge.receive({
      source,
      origin,
      ports: [callbacks as unknown as MessagePort],
      data: {
        protocol: MODULE_PROTOCOL,
        channel,
        kind: "request",
        id: "test-request",
        method: "notifications.send",
        params,
        ...fields,
      },
    });
    return { ...callbacks, promise };
  }

  function subscribe() {
    const callbacks = { postMessage: vi.fn(), close: vi.fn() };
    const promise = bridge.receive({
      source: frame,
      origin: "null",
      ports: [callbacks as unknown as MessagePort],
      data: { protocol: MODULE_PROTOCOL, channel, kind: "subscribe" },
    });
    return { ...callbacks, promise };
  }

  return { bridge, otherFrame, permissions, send, packet, subscribe };
}

function denied(postMessage: ReturnType<typeof vi.fn>, code: ModuleErrorCode) {
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code }),
    }),
  );
}

describe("模块消息桥", () => {
  it("要求当前 iframe、不透明来源和正确会话凭证", async () => {
    const { packet, otherFrame, send } = fixture();
    for (const options of [
      { source: otherFrame },
      { origin: "https://example.invalid" },
      { channel: otherChannel },
    ]) {
      const call = packet(options);
      await call.promise;
      expect(call.postMessage).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("授权时仅向转交端口响应，撤销后相同页面请求立即被拒绝", async () => {
    const { packet, permissions, send } = fixture();
    const first = packet();
    await first.promise;
    expect(first.postMessage).toHaveBeenCalledWith({
      protocol: MODULE_PROTOCOL,
      kind: "response",
      id: "test-request",
      ok: true,
      value: null,
    });
    expect(first.close).toHaveBeenCalledOnce();
    permissions.splice(0, 1);
    const second = packet();
    await second.promise;
    denied(second.postMessage, "PERMISSION_DENIED");
    expect(send).toHaveBeenCalledOnce();
  });

  it("拒绝未知方法、额外字段及超额通知", async () => {
    const { packet, send } = fixture();
    for (const options of [
      { method: "constructor" },
      { params: { title: "番茄钟", moduleId: "com.example.other" } },
    ]) {
      const result = packet(options);
      await result.promise;
      denied(result.postMessage, "INVALID_REQUEST");
    }
    expect(send).not.toHaveBeenCalled();
    const limit = fixture();
    for (let index = 0; index < 3; index++) await limit.packet().promise;
    const fourth = limit.packet();
    await fourth.promise;
    denied(fourth.postMessage, "RATE_LIMITED");
    expect(limit.send).toHaveBeenCalledTimes(3);
  });

  it("事件只通过订阅端口分发有读权限的数据域", async () => {
    const { bridge, permissions, subscribe } = fixture();
    const listener = subscribe();
    await listener.promise;
    bridge.dataChanged("memos");
    bridge.dataChanged("calendar");
    permissions.length = 0;
    bridge.dataChanged("calendar");
    bridge.close();
    expect(listener.postMessage).toHaveBeenCalledExactlyOnceWith({
      protocol: MODULE_PROTOCOL,
      kind: "event",
      event: "data-changed",
      value: { domain: "calendar" },
    });
    expect(listener.close).toHaveBeenCalledOnce();
  });
});
