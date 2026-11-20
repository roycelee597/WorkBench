// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AiSettings } from "../../../workbenches/ai/src/AiSettings";
import { createAiApi } from "../../../workbenches/ai/src/api";
import type { JsonValue } from "../src/core/repositories/models";
import type { AiInvoker } from "../src/core/ai/llm-client";
import { aiReadPolicy, publishReadPolicy } from "../../../workbenches/ai/src/ai-preferences";

const usage = {
  date: "2026-11-14",
  calls: 3,
  minute: 0,
  minute_calls: 0,
  prompt_tokens: 12,
  completion_tokens: 4,
};
let root: Root;
let container: HTMLDivElement;
let saved: Map<string, JsonValue>;
let call: ReturnType<typeof vi.fn<AiInvoker>>;
let configured: boolean;
let keyReadFailure: boolean;
beforeEach(() => {
  publishReadPolicy(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  saved = new Map();
  configured = false;
  keyReadFailure = false;
  let limits = { enabled: false, daily: 300, per_minute: 20 };
  call = vi.fn<AiInvoker>(async (command: string, args) => {
    if (command === "ai_key_status" && keyReadFailure) {
      keyReadFailure = false;
      throw { code: "STORAGE_ERROR" };
    }
    if (command === "ai_get_call_limits") return limits;
    if (command === "ai_set_call_limits") {
      limits = args?.limits as typeof limits;
      return limits;
    }
    if (command === "ai_key_set") configured = true;
    if (command === "ai_key_clear") {
      configured = false;
      return;
    }
    if (command === "ai_key_test") return { ok: true };
    return { configured, tail: configured ? "ab12" : null, usage };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function api() {
  return createAiApi(
    async () => ({
      getValue: async (key) => saved.get(key),
      setValue: async (key, value) => {
        saved.set(key, value);
      },
    }),
    call,
  );
}
async function render() {
  const value = api();
  await act(async () => root.render(<AiSettings api={value} />));
  return value;
}
function button(text: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function saveKey() {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "sk-fake-workbench-test-ab12";
  await act(async () => container.querySelector("form")!.requestSubmit());
  return input;
}

describe("AI 设置及唯一数据入口", () => {
  it("默认启用读取和六步限制，调用限额独立通过 Rust 设置", async () => {
    const value = await render();
    const checkbox = (title: string) =>
      Array.from(container.querySelectorAll("label"))
        .find((label) => label.textContent?.trim() === title)
        ?.querySelector<HTMLInputElement>("input");
    expect(checkbox("允许 AI 读取日程和提醒")?.checked).toBe(true);
    expect(checkbox("限制每条消息的 AI 步数")?.checked).toBe(true);
    expect(checkbox("启用调用限额")?.checked).toBe(false);
    await act(async () => checkbox("启用调用限额")?.click());
    expect(call).toHaveBeenCalledWith("ai_set_call_limits", {
      limits: { enabled: true, daily: 300, per_minute: 20 },
    });
    await value.saveCallLimits({ enabled: true, daily: 10, per_minute: 2 });
    expect(await value.loadCallLimits()).toEqual({ enabled: true, daily: 10, per_minute: 2 });
    expect(saved.size).toBe(0);
  });

  it("关闭读取在持久化前生效，磁盘错误后也不恢复读取", async () => {
    const write = vi.fn(async () => {
      throw new Error("数据库暂时不可写");
    });
    const value = createAiApi(
      async () => ({
        getValue: async () => true,
        setValue: write,
      }),
      call,
    );
    const attempt = value.saveReadEnabled(false);
    expect(aiReadPolicy.isAllowed()).toBe(false);
    await expect(attempt).rejects.toThrow();
    expect(await value.loadReadEnabled()).toBe(false);
  });
  it("状态读取失败时不误报未设置，仍允许清除系统凭据", async () => {
    keyReadFailure = true;
    await render();
    expect(container.textContent).toContain("无法读取凭据状态");
    expect(container.textContent).not.toContain("尚未设置");
    expect(button("清除").disabled).toBe(false);
    await click("清除");
    expect(call).toHaveBeenCalledWith("ai_key_clear");
    expect(container.textContent).toContain("尚未设置");
  });
  it("密钥保存后只显示尾号，输入清空，不写入任何设置", async () => {
    await render();
    const input = await saveKey();
    expect(input.value).toBe("");
    expect(container.textContent).toContain("已设置（尾号 ab12）");
    expect(container.innerHTML).not.toContain("sk-fake-workbench-test-ab12");
    expect(saved.size).toBe(0);
    expect(call).toHaveBeenCalledWith("ai_key_set", { key: "sk-fake-workbench-test-ab12" });
    await click("测试连接");
    expect(container.textContent).toContain("连接正常");
    await click("清除");
    expect(container.textContent).toContain("尚未设置");
    expect(call).toHaveBeenCalledWith("ai_key_clear");
  });
  it("模型经仓库保存并重载，用量来自 Rust，不创建 ai.usage 设置", async () => {
    await render();
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "deepseek-v4-pro";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saved.get("ai.model")).toBe("deepseek-v4-pro");
    expect(await api().loadModel()).toBe("deepseek-v4-pro");
    expect(saved.has("ai.usage")).toBe(false);
    expect(container.textContent).toContain("已调用 3 次");
  });
  it("错误只显示本地说明，保存失败也清空密码框，点击期间不能重复请求", async () => {
    await render();
    let reject!: (error: unknown) => void;
    call.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const input = await saveKey();
    expect(input.value).toBe("");
    expect(button("保存").disabled).toBe(true);
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(call.mock.calls.filter(([name]) => name === "ai_key_set")).toHaveLength(1);
    await act(async () => reject({ code: "KEY_FORMAT", message: "sk-fake-workbench-test-ab12" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("20–200");
    expect(container.textContent).not.toContain("sk-fake-workbench-test-ab12");
  });
  it("无效状态响应被拒绝；模型保存失败保留旧值", async () => {
    const value = api();
    call.mockResolvedValueOnce({ configured: true, tail: "ab12", key: "private", usage });
    await expect(value.keyStatus()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    call.mockResolvedValueOnce({ ok: false });
    await expect(value.testKey()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const broken = { ...value, saveModel: vi.fn().mockRejectedValue({ code: "STORAGE_ERROR" }) };
    await act(async () => root.render(<AiSettings api={broken} />));
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "deepseek-v4-pro";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select.value).toBe("deepseek-flash");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法保存");
  });
});
