import { describe, expect, it, vi } from "vitest";
import { createAiStore } from "../../../workbenches/ai/src/ai-store";
import { createAiApi } from "../../../workbenches/ai/src/api";
import { configureAiHostServices } from "../../../workbenches/ai/src/host-services";
import type { AiKeyStatus, LlmClient, LlmResponse } from "../src/core/ai/llm-client";
import type { JsonValue } from "../src/core/repositories/models";

const now = Date.parse("2026-11-15T04:00:00Z");
const usage = {
  date: "2026-11-15",
  calls: 0,
  minute: 0,
  minute_calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
};
const status = (configured = true): AiKeyStatus => ({
  configured,
  tail: configured ? "test" : null,
  usage,
});
const reply = (content = "你好，我可以介绍如何使用工作台。"): LlmResponse => ({
  content,
  tool_calls: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup() {
  let id = 0;
  const api = {
    keyStatus: vi.fn(async () => status()),
    loadModel: vi.fn(async () => "deepseek-flash" as const),
    chat: vi.fn<LlmClient["chat"]>(async () => reply()),
  };
  const store = createAiStore(api, { now: () => now, newId: () => `message-${++id}` });
  return { api, store };
}

describe("AI 对话内存状态", () => {
  it("发送会读取最新凭据和模型，正式请求没有任何业务工具，回复只留在内存", async () => {
    const { api, store } = setup();
    store.getState().setDraft("  你好  ");
    await store.getState().send();
    expect(api.keyStatus).toHaveBeenCalledOnce();
    expect(api.loadModel).toHaveBeenCalledOnce();
    expect(api.chat).toHaveBeenCalledOnce();
    expect(api.chat.mock.calls[0]![0]).toMatchObject({ model: "deepseek-flash", tools: [] });
    expect(api.chat.mock.calls[0]![0].messages.at(-1)).toEqual({ role: "user", content: "你好" });
    expect(store.getState().messages).toEqual([
      { id: "message-1", createdAt: now, role: "user", text: "你好" },
      {
        id: "message-2",
        createdAt: now,
        role: "assistant",
        event: { type: "text", text: reply().content },
      },
    ]);
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState()).toMatchObject({ draft: "", pending: false, activity: "" });
    expect(createAiStore(api).getState().messages).toEqual([]);
  });

  it("空白和超长输入不会请求上游，按 Unicode 字符计数而不是 UTF-16 长度", async () => {
    const { api, store } = setup();
    store.getState().setDraft(" \n ");
    await store.getState().send();
    expect(store.getState().messages).toEqual([]);
    store.getState().setDraft("字".repeat(1_001));
    await store.getState().send();
    expect(store.getState().messages[0]).toMatchObject({
      role: "assistant",
      event: { type: "error", fallback: "manual" },
    });
    expect(store.getState().draft).toHaveLength(1_001);
    expect(api.keyStatus).not.toHaveBeenCalled();
    expect(api.chat).not.toHaveBeenCalled();
    store.getState().setDraft("😀".repeat(1_000));
    await store.getState().send();
    expect(api.chat).toHaveBeenCalledOnce();
  });

  it("正在发送时拒绝重复请求和清空，完成后保留用户为下一句输入的草稿", async () => {
    const { api, store } = setup();
    const pending = deferred<LlmResponse>();
    api.chat.mockReturnValueOnce(pending.promise);
    store.getState().setDraft("第一句");
    const sending = store.getState().send();
    await vi.waitFor(() => expect(api.chat).toHaveBeenCalledOnce());
    store.getState().setDraft("下一句草稿");
    await store.getState().send();
    store.getState().clear();
    expect(store.getState()).toMatchObject({ pending: true, draft: "下一句草稿" });
    expect(store.getState().messages).toHaveLength(1);
    expect(api.chat).toHaveBeenCalledOnce();
    pending.resolve(reply());
    await sending;
    expect(store.getState()).toMatchObject({ pending: false, draft: "下一句草稿", activity: "" });
    store.getState().clear();
    expect(store.getState()).toMatchObject({ messages: [], history: [], draft: "下一句草稿" });
    expect(store.getState().key?.configured).toBe(true);
  });

  it("无凭据时不调用模型，失败只显示本地错误，不把上游细节带入历史", async () => {
    const { api, store } = setup();
    api.keyStatus.mockResolvedValueOnce(status(false));
    store.getState().setDraft("你好");
    await store.getState().send();
    expect(api.chat).not.toHaveBeenCalled();
    expect(store.getState().messages.at(-1)).toMatchObject({
      role: "assistant",
      event: { type: "error", code: "KEY_MISSING", fallback: "settings" },
    });
    expect(store.getState().history).toEqual([]);
    api.chat.mockRejectedValueOnce({ code: "NETWORK", message: "private upstream detail" });
    store.getState().setDraft("再试一次");
    await store.getState().send();
    expect(store.getState().messages.at(-1)).toMatchObject({
      role: "assistant",
      event: { type: "error", code: "NETWORK", fallback: "manual" },
    });
    expect(JSON.stringify(store.getState().messages)).not.toContain("private upstream detail");
    expect(store.getState()).toMatchObject({ pending: false, activity: "" });
    expect(store.getState().history).toEqual([
      {
        createdAt: now,
        user: "再试一次",
        text: "（本轮未能完成，请重新说明或手动操作）",
        exchanges: [],
        readDerived: false,
      },
    ]);
    expect(JSON.stringify(store.getState().history)).not.toContain("private upstream detail");
  });

  it("后发的状态刷新优先，过时请求既不能覆盖凭据也不能结束正在读取状态", async () => {
    const { api, store } = setup();
    const first = deferred<AiKeyStatus>();
    const second = deferred<AiKeyStatus>();
    api.keyStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const earlier = store.getState().refresh();
    const latest = store.getState().refresh();
    first.resolve(status(false));
    await earlier;
    expect(store.getState()).toMatchObject({ checking: true, key: null });
    second.resolve(status());
    await latest;
    expect(store.getState()).toMatchObject({
      checking: false,
      key: status(),
      connectionError: null,
    });
    api.keyStatus.mockRejectedValueOnce({ code: "STORAGE_ERROR", message: "private" });
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({
      checking: false,
      key: null,
      connectionError: { type: "error", code: "STORAGE_ERROR", fallback: "settings" },
    });
  });
});

describe("AI 快捷键唯一数据入口", () => {
  it("存储只使用 AI 自己的设置键并标准化组合，host API 原样委托当前绑定状态", async () => {
    const saved = new Map<string, JsonValue>();
    const setValue = vi.fn(async (key: string, value: JsonValue) => {
      saved.set(key, value);
    });
    const api = createAiApi(
      async () => ({ getValue: async (key) => saved.get(key), setValue }),
      vi.fn(),
    );
    expect(await api.getStoredShortcut()).toBe("Ctrl+Alt+Space");
    await api.setStoredShortcut("alt+ctrl+space");
    expect(saved.get("ai.global_shortcut")).toBe("Ctrl+Alt+Space");
    expect(setValue).toHaveBeenCalledExactlyOnceWith("ai.global_shortcut", "Ctrl+Alt+Space");
    await expect(api.setStoredShortcut("Ctrl+Space")).rejects.toThrow();
    expect(setValue).toHaveBeenCalledOnce();
    const current = { configured: "Ctrl+Alt+Space", active: "Ctrl+Alt+Space", error: null };
    const next = { configured: "Ctrl+Shift+Space", active: "Ctrl+Shift+Space", error: null };
    const getShortcut = vi.fn(async () => current);
    const setShortcut = vi.fn(async () => next);
    const restore = configureAiHostServices({ getShortcut, setShortcut });
    try {
      expect(await api.getGlobalShortcut()).toBe(current);
      expect(await api.setGlobalShortcut("Ctrl+Shift+Space")).toBe(next);
      expect(setShortcut).toHaveBeenCalledExactlyOnceWith("Ctrl+Shift+Space");
      expect(getShortcut).toHaveBeenCalledOnce();
      expect(setValue).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });
});
