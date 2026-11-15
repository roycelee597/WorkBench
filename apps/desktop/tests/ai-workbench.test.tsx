// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AiWorkbench } from "../../../workbenches/ai/src/AiWorkbench";
import { createAiStore } from "../../../workbenches/ai/src/ai-store";
import type { AiKeyStatus, LlmClient, LlmResponse } from "../src/core/ai/llm-client";

const usage = {
  date: "2026-11-15",
  calls: 0,
  minute: 0,
  minute_calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
};
const keyStatus = (configured = true): AiKeyStatus => ({
  configured,
  tail: configured ? "test" : null,
  usage,
});
const reply = (content = "你好，欢迎使用工作台。"): LlmResponse => ({
  content,
  tool_calls: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const value = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!value) throw new Error(`找不到按钮：${text}`);
  return value;
}
function input() {
  return container.querySelector("textarea")!;
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input(),
      value,
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function key(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => input().dispatchEvent(event));
  return event;
}
async function render(configured = true) {
  const api = {
    keyStatus: vi.fn(async () => keyStatus(configured)),
    loadModel: vi.fn(async () => "deepseek-flash" as const),
    chat: vi.fn<LlmClient["chat"]>(async () => reply()),
  };
  let id = 0;
  const store = createAiStore(api, {
    now: () => Date.parse("2026-11-15T04:00:00Z"),
    newId: () => `m-${++id}`,
  });
  const openSettings = vi.fn();
  const manualCreate = vi.fn();
  const props = { store, openSettings, manualCreate, focusVersion: 1 };
  await act(async () => root.render(<AiWorkbench {...props} />));
  return { api, store, openSettings, manualCreate, props };
}

describe("AI 助手对话页", () => {
  it("无 key 显示引导，示例只填草稿并聚焦，不能偷偷发送", async () => {
    const { api, store, openSettings } = await render(false);
    expect(container.textContent).toContain("先连接你的 AI 助手");
    await click("去设置");
    expect(openSettings).toHaveBeenCalledOnce();
    const example = container.querySelector<HTMLButtonElement>(".ai-examples button")!;
    const text = example.firstChild!.textContent;
    await act(async () => example.click());
    expect(input().value).toBe(text);
    expect(store.getState().draft).toBe(text);
    expect(document.activeElement).toBe(input());
    expect(button("发送").disabled).toBe(true);
    await key();
    expect(api.chat).not.toHaveBeenCalled();
    expect(store.getState().messages).toEqual([]);
  });

  it("用户与模型文字只作为文本渲染，不执行 HTML、脚本或 Markdown", async () => {
    const { api } = await render();
    const answer = "<script>window.bad = true</script> **粗体** [未知 e999]";
    api.chat.mockResolvedValueOnce(reply(answer));
    const text = '<img src=x onerror="bad()">';
    await type(text);
    await click("发送");
    const log = container.querySelector('[role="log"]')!;
    expect(log.textContent).toContain(text);
    expect(log.textContent).toContain(answer);
    expect(log.querySelector("script, img, strong, a")).toBeNull();
    expect(container.textContent).not.toContain("从一句话开始");
  });

  it("IME 合成、229 键码和 Shift+Enter 不发送，普通 Enter 只发送一次", async () => {
    const { api } = await render();
    await type("你好");
    expect((await key({ isComposing: true })).defaultPrevented).toBe(false);
    expect((await key({ keyCode: 229 })).defaultPrevented).toBe(false);
    expect((await key({ shiftKey: true })).defaultPrevented).toBe(false);
    await act(async () =>
      input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
    await key();
    expect(api.chat).not.toHaveBeenCalled();
    await act(async () =>
      input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    expect((await key()).defaultPrevented).toBe(true);
    expect(api.chat).toHaveBeenCalledOnce();
  });

  it("发送中显示状态并拦截重复发送，下一句草稿可编辑且回复到达后仍保持焦点", async () => {
    const { api, store } = await render();
    let finish!: (value: LlmResponse) => void;
    api.chat.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await type("第一句");
    await key();
    expect(store.getState().pending).toBe(true);
    expect(button("正在理解…").disabled).toBe(true);
    expect(button("清空对话").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("正在理解");
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
    await type("下一句还没写完");
    await key();
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(api.chat).toHaveBeenCalledOnce();
    await act(async () => finish(reply()));
    expect(input().value).toBe("下一句还没写完");
    expect(document.activeElement).toBe(input());
    expect(button("发送").disabled).toBe(false);
  });

  it("清空移除消息和历史，保留未发送草稿；重新唤起时聚焦输入框", async () => {
    const { store, props } = await render();
    await type("先发一句");
    await click("发送");
    await type("保留这句草稿");
    await click("清空对话");
    expect(container.querySelector('[role="log"]')).toBeNull();
    expect(store.getState().history).toEqual([]);
    expect(input().value).toBe("保留这句草稿");
    button("设置").focus();
    await act(async () => root.render(<AiWorkbench {...props} focusVersion={2} />));
    expect(document.activeElement).toBe(input());
  });

  it.each(["KEY_INVALID", "NETWORK"] as const)(
    "%s 显示本地错误及可操作的设置/手动入口",
    async (code) => {
      const { api, openSettings, manualCreate } = await render();
      api.chat.mockRejectedValueOnce({ code, message: "不应显示的服务端细节" });
      await type("你好");
      await click("发送");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("这次没有完成");
      expect(container.textContent).not.toContain("不应显示的服务端细节");
      await click("手动新建");
      expect(manualCreate).toHaveBeenCalledOnce();
      if (code === "KEY_INVALID") {
        await click("去设置");
        expect(openSettings).toHaveBeenCalledOnce();
      }
    },
  );
});
