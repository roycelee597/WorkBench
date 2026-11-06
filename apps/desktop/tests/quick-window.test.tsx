// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCreateWindow } from "../src/shell/QuickCreateWindow";
import { timeInZone } from "../../../workbenches/general/src/calendar-model";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  request: vi.fn(),
  opened: null as null | (() => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
vi.mock("../src/shell/quick-bridge", () => ({ sendQuickRequest: mock.request }));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 6, 12));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  mock.request.mockImplementation(async (payload) =>
    payload.type === "preferences" ? { theme: "system", defaultReminder: null } : { id: "saved" },
  );
  mock.listen.mockImplementation(async (_name: string, opened: () => void) => {
    mock.opened = opened;
    return () => undefined;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<QuickCreateWindow />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function inputTitle(text: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("独立快速新建窗口", () => {
  it("Esc 收起窗口；重开保留未保存输入", async () => {
    await inputTitle("草稿不能丢");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(mock.invoke).toHaveBeenCalledWith("hide_quick_create");
    vi.setSystemTime(new Date(2026, 10, 7, 12));
    await act(async () => mock.opened!());
    expect(container.querySelector("input")?.value).toBe("草稿不能丢");
  });
  it("空白窗口再次呼出时刷新默认日期，不沿用前一天的时间", async () => {
    vi.setSystemTime(new Date(2026, 10, 7, 12));
    await act(async () => mock.opened!());
    const event = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "日程",
    )!;
    await act(async () => event.click());
    expect(container.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).toBe(
      timeInZone(Date.now() + 3_600_000, Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
  });
  it("保存过程中不接受重复 Esc/提交，成功后清空并收起", async () => {
    let finish!: () => void;
    mock.request.mockImplementation((payload) =>
      payload.type === "preferences"
        ? Promise.resolve({ theme: "system", defaultReminder: null })
        : new Promise<void>((resolve) => {
            finish = resolve;
          }),
    );
    await inputTitle("即将保存");
    await act(async () => container.querySelector("form")!.requestSubmit());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(mock.invoke).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mock.invoke).toHaveBeenCalledWith("hide_quick_create");
    expect(container.querySelector("input")?.value).toBe("");
  });
});
