// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateDraftDialog } from "../../../workbenches/general/src/components/CreateDraftDialog";
import type { AiCreateDraft } from "../../../workbenches/general/src/ai-create-model";
import type { AiTarget } from "../src/core/ai/action-types";

const mock = vi.hoisted(() => ({ execute: vi.fn(), validate: vi.fn() }));
vi.mock("../../../workbenches/general/src/ai-actions", () => ({
  generalAiActions: {
    actions: [{ name: "memos_create", execute: mock.execute, validate: mock.validate }],
  },
}));
const initial: AiCreateDraft = {
  type: "memo",
  form: { title: "从 AI 带来的标题", content: "从 AI 带来的正文", pinned: false, tags: ["原标签"] },
};
const target: AiTarget = { kind: "memo", memoId: "saved-memo" };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.validate.mockReset().mockReturnValue([]);
  mock.execute.mockReset().mockResolvedValue({ message: "已新建备忘录", target });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function deferred() {
  let resolve!: (value: { message: string; target: AiTarget }) => void;
  const promise = new Promise<{ message: string; target: AiTarget }>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function button(text: string) {
  const element = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  if (!element) throw new Error(`找不到按钮：${text}`);
  return element;
}
function field(text: string) {
  const label = [...document.querySelectorAll("label")].find(
    (item) =>
      [...item.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("")
        .trim() === text,
  );
  if (!label?.control) throw new Error(`找不到字段：${text}`);
  return label.control as HTMLInputElement | HTMLTextAreaElement;
}
async function edit(text: string, value: string) {
  const input = field(text);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function render(onSaved = vi.fn<(target?: AiTarget) => void>()) {
  const onClose = vi.fn();
  const props = { initial, open: true, onClose, onSaved };
  await act(async () => root.render(<CreateDraftDialog {...props} />));
  return { props, onClose, onSaved };
}

describe("AI 草稿转入综合工作台手动表单", () => {
  it("打开与编辑都不写入，保存只提交用户最后修改的草稿", async () => {
    const { onSaved } = await render();
    expect(mock.execute).not.toHaveBeenCalled();
    expect(field("标题").value).toBe("从 AI 带来的标题");
    await edit("标题", "手动改后的标题");
    await edit("正文", "手动补充的正文");
    expect(mock.execute).not.toHaveBeenCalled();
    await click("保存");
    expect(mock.validate).toHaveBeenCalledExactlyOnceWith({
      ...initial,
      form: { ...initial.form, title: "手动改后的标题", content: "手动补充的正文" },
    });
    expect(mock.execute).toHaveBeenCalledExactlyOnceWith({
      ...initial,
      form: { ...initial.form, title: "手动改后的标题", content: "手动补充的正文" },
    });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(target);
    expect(button("已保存").disabled).toBe(true);
    expect(field("标题").matches(":disabled")).toBe(true);
  });

  it("同步双击只写一次，保存中阻止重复提交与 Escape 关闭", async () => {
    const pending = deferred();
    mock.execute.mockReturnValueOnce(pending.promise);
    const { onClose, onSaved } = await render();
    await act(async () => {
      const save = button("保存");
      save.click();
      save.click();
    });
    expect(mock.execute).toHaveBeenCalledOnce();
    expect(button("正在保存…").disabled).toBe(true);
    expect(button("取消").disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.querySelector<HTMLFormElement>("#create-draft-form")!.requestSubmit();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mock.execute).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ message: "已保存", target }));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("同步保存失败也不因双击自动重试，保留编辑并允许用户再次保存", async () => {
    mock.execute.mockImplementationOnce(() => {
      throw new Error("模拟磁盘写入失败");
    });
    const { onSaved } = await render();
    await edit("正文", "失败时仍保留的正文");
    await act(async () => {
      const save = button("保存");
      save.click();
      save.click();
    });
    expect(mock.execute).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("草稿仍保留");
    expect(field("正文").value).toBe("失败时仍保留的正文");
    await click("保存");
    expect(mock.execute).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("未保存直接取消不创建记录；隐藏再打开同一个表单保留编辑", async () => {
    const { props, onClose } = await render();
    await edit("标题", "切工作台前的手动编辑");
    await act(async () => root.render(<CreateDraftDialog {...props} open={false} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<CreateDraftDialog {...props} open />));
    expect(field("标题").value).toBe("切工作台前的手动编辑");
    await click("取消");
    expect(onClose).toHaveBeenCalledOnce();
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it("保存后的同步导航异常不会解锁写入，显示已保存且仍可关闭", async () => {
    const onSaved = vi.fn(() => {
      throw new Error("导航不可用");
    });
    const { onClose } = await render(onSaved);
    await click("保存");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "内容已保存，暂时无法打开",
    );
    expect(button("已保存").disabled).toBe(true);
    await act(async () => {
      button("已保存").click();
      document.querySelector<HTMLFormElement>("#create-draft-form")!.requestSubmit();
    });
    expect(mock.execute).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledOnce();
    await click("关闭");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("本地校验失败只显示纯文本，不执行保存，编辑后可继续", async () => {
    mock.validate.mockReturnValueOnce(["<script>标题无效</script>"]);
    await render();
    await click("保存");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "<script>标题无效</script>",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(mock.execute).not.toHaveBeenCalled();
    await edit("标题", "修正标题");
    await click("保存");
    expect(mock.execute).toHaveBeenCalledOnce();
  });
});
