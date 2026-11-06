// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCreateForm } from "../src/components/QuickCreateForm";
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
async function title(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
describe("快速新建键盘行为", () => {
  it("类型和关闭按钮的 Enter 保留按钮行为，不会误提交", async () => {
    const save = vi.fn(async () => undefined);
    const close = vi.fn();
    const dirty = vi.fn();
    await act(async () =>
      root.render(
        <QuickCreateForm onSave={save} onClose={close} onBusy={() => undefined} onDirty={dirty} />,
      ),
    );
    await title("待保存");
    const type = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "日程",
    )!;
    await act(async () => {
      type.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      type.click();
    });
    expect(save).not.toHaveBeenCalled();
    expect(type.getAttribute("aria-pressed")).toBe("true");
    expect(dirty).toHaveBeenCalled();
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "关闭",
    )!;
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.click();
    });
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
  it("Enter 保存，输入法确认及 Shift+Enter 不误保存", async () => {
    const save = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <QuickCreateForm onSave={save} onClose={() => undefined} onBusy={() => undefined} />,
      ),
    );
    const input = await title("速记");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, shiftKey: true }),
      );
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(save).toHaveBeenCalledWith({ type: "memo", title: "速记", content: "" });
  });
  it("同一帧重复提交只保存一次，失败后保留输入并显示错误", async () => {
    let fail!: (error: Error) => void;
    const save = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await act(async () =>
      root.render(
        <QuickCreateForm onSave={save} onClose={() => undefined} onBusy={() => undefined} />,
      ),
    );
    const input = await title("保留草稿");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => fail(new Error("存储失败")));
    expect(container.querySelector("input")?.value).toBe("保留草稿");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("存储失败");
  });
  it("切换提醒保留标题并可保存普通待办，空内容不调用数据层", async () => {
    const save = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <QuickCreateForm onSave={save} onClose={() => undefined} onBusy={() => undefined} />,
      ),
    );
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(save).not.toHaveBeenCalled();
    await title("待办");
    const reminder = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "提醒",
    )!;
    await act(async () => reminder.click());
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reminder", title: "待办", due_at: null }),
    );
  });
});
