// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiInvoker } from "../src/core/ai/llm-client";
import { AiHistorySettings } from "../../../workbenches/ai/src/AiHistorySettings";
import { AiWorkbench } from "../../../workbenches/ai/src/AiWorkbench";
import { createAiStore } from "../../../workbenches/ai/src/ai-store";
import { createAiApi } from "../../../workbenches/ai/src/api";
import { fixture } from "./memory-database";

const usage = {
  date: "2026-11-20",
  minute: 0,
  calls: 1,
  minute_calls: 1,
  prompt_tokens: 3,
  completion_tokens: 2,
};

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found;
}

async function setup() {
  const { db, data, clock } = await fixture();
  const invoke = vi.fn<AiInvoker>(async (command) => {
    if (command === "ai_key_status") return { configured: true, tail: "test", usage };
    if (command === "ai_chat")
      return {
        content: "正常回复",
        tool_calls: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    throw new Error("测试收到意外 IPC");
  });
  const api = createAiApi(
    async () => data.settings,
    invoke,
    async () => data.aiMessages,
  );
  const store = createAiStore(api, { now: () => clock.now });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    store.getState().dispose();
    container.remove();
    db.close();
  };
  return { db, api, store, container, root, invoke };
}

let cleanup = async () => {};
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
  vi.unstubAllGlobals();
});

describe("AI 对话记录与界面", () => {
  it("重启只还原展示文本和失效卡片，旧短引用没有按钮且不会进入模型请求", async () => {
    const { api, store, root, container, invoke } = await setup();
    await api.appendHistory({ role: "user", text: "上一进程的合成输入" });
    await api.appendHistory({ role: "assistant", text: "<script>普通文本</script> [e1]" });
    await api.appendHistory({ role: "results" });
    await api.appendHistory({
      role: "card",
      text: "新建日程",
      status: "pending",
      payload: { kind: "create" },
    });
    await act(async () =>
      root.render(
        <AiWorkbench
          store={store}
          focusVersion={0}
          openSettings={vi.fn()}
          manualCreate={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("上一进程的合成输入");
    expect(container.textContent).toContain("<script>普通文本</script> [e1]");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("请重新查询");
    expect(container.textContent).toContain("已失效");
    expect(container.textContent).not.toContain("在表单中打开");
    expect(store.getState().proposals).toEqual({});
    expect(store.getState().history).toEqual([]);
    await act(async () => {
      store.getState().setDraft("新一轮输入");
      await store.getState().send();
    });
    const [, args] = invoke.mock.calls.find(([command]) => command === "ai_chat")!;
    expect(JSON.stringify(args)).not.toContain("上一进程的合成输入");
    expect(JSON.stringify(args)).not.toContain("[e1]");
    expect((await api.loadHistory()).at(-1)?.text).toBe("正常回复");
  });

  it("设置关闭后保留已有记录，清空经第二次确认并删除本机内容", async () => {
    const { api, store, root, container, db } = await setup();
    const row = await api.appendHistory({ role: "user", text: "将被清空的合成内容" });
    await act(async () => root.render(<AiHistorySettings api={api} store={store} />));
    const toggle = container.querySelector("input")!;
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    await act(async () => {
      store.getState().setDraft("关闭后只留内存");
      await store.getState().send();
    });
    expect(store.getState().messages.length).toBeGreaterThan(1);
    expect((await api.loadHistory()).map((message) => message.id)).toEqual([row!.id]);
    await act(async () => button("清空对话记录").click());
    expect(await api.loadHistory()).toHaveLength(1);
    await act(async () => button("取消").click());
    expect(await api.loadHistory()).toHaveLength(1);
    await act(async () => button("清空对话记录").click());
    await act(async () => button("确认清空").click());
    expect(container.textContent).toContain("已清空对话记录");
    expect(await api.loadHistory()).toEqual([]);
    expect(store.getState().messages).toEqual([]);
    expect(
      db.connection
        .prepare("SELECT text, payload, deleted_at, purged_at FROM ai_messages WHERE id = ?")
        .get(row!.id),
    ).toMatchObject({
      text: "",
      payload: "{}",
      deleted_at: expect.any(Number),
      purged_at: expect.any(Number),
    });
  });
});
