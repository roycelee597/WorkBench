// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiWorkbench } from "../../../workbenches/ai/src/AiWorkbench";
import { createAiStore, type AiStore } from "../../../workbenches/ai/src/ai-store";
import type { AiActionDefinition, AiTarget, Prepared } from "../src/core/ai/action-types";
import { AiClientError, type AiKeyStatus, type LlmResponse } from "../src/core/ai/llm-client";
import { AiRegistry } from "../src/core/ai/registry";
import { MockLlmClient } from "./mock-llm-client";

const now = Date.parse("2026-11-16T04:00:00Z");
const schema = z.object({ title: z.string(), content: z.string() }).strict();
type Draft = z.infer<typeof schema>;
const target: AiTarget = { kind: "memo", memoId: "local-private-saved-id" };
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const response = (count = 1): LlmResponse => ({
  content: null,
  tool_calls: Array.from({ length: count }, (_, index) => ({
    id: `call-${index}`,
    name: "memos_create",
    arguments: JSON.stringify({ title: `标题 ${index + 1}`, content: "原始内容" }),
  })),
  usage,
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
function setup(steps: Array<LlmResponse | Error> = [response()]) {
  const registry = new AiRegistry();
  const client = new MockLlmClient(steps);
  const execute = vi.fn<(draft: Draft) => Promise<{ message: string; target: AiTarget }>>(
    async () => ({ message: "已保存测试备忘录", target }),
  );
  const validate = vi.fn((draft: Draft) => (draft.title.trim() ? [] : ["标题不能为空"]));
  const prepare = vi.fn(async (draft: Draft): Promise<Prepared<Draft>> => ({
    type: "proposal",
    draft,
    note: "测试提示：提前提醒已调整",
  }));
  const action: AiActionDefinition<Draft> = {
    name: "memos_create",
    workbenchId: "test.general",
    kind: "write",
    description: "测试新建备忘录",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string" } },
      required: ["title", "content"],
      additionalProperties: false,
    },
    args: schema,
    prepare,
    validate,
    execute,
    Preview: ({ draft, onChange, readOnly }) => (
      <div>
        <label>
          测试标题
          <input
            aria-label="测试标题"
            value={draft.title}
            disabled={readOnly}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          测试内容
          <textarea
            aria-label="测试内容"
            value={draft.content}
            disabled={readOnly}
            onChange={(event) => onChange({ ...draft, content: event.target.value })}
          />
        </label>
        <p>{draft.content}</p>
      </div>
    ),
  };
  registry.register({ workbenchId: "test.general", label: "测试新建", actions: [action] });
  const key: AiKeyStatus = {
    configured: true,
    tail: "test",
    usage: {
      date: "2026-11-16",
      calls: 0,
      minute: 0,
      minute_calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
    },
  };
  const api = {
    keyStatus: vi.fn(async () => key),
    loadModel: vi.fn(async () => "deepseek-flash" as const),
    chat: client.chat.bind(client),
    openTarget: vi.fn<(target: AiTarget) => Promise<void>>(async () => undefined),
    openCreateForm: vi.fn<(name: string, draft: unknown) => Promise<void>>(async () => undefined),
  };
  let id = 0;
  const store = createAiStore(api, { registry, now: () => now, newId: () => `message-${++id}` });
  return { store, api, client, execute, validate, prepare };
}

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
async function render(store: AiStore) {
  await act(async () =>
    root.render(
      <AiWorkbench
        store={store}
        openSettings={() => undefined}
        manualCreate={() => undefined}
        focusVersion={1}
      />,
    ),
  );
}
async function send(store: AiStore, text = "记一条备忘录") {
  await act(async () => {
    store.getState().setDraft(text);
    await store.getState().send();
  });
}
function buttons(text: string) {
  return [...container.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === text,
  );
}
async function click(text: string, index = 0) {
  await act(async () => buttons(text)[index]!.click());
}
async function edit(value: string, index = 0) {
  const input = container.querySelectorAll<HTMLInputElement>('input[aria-label="测试标题"]')[
    index
  ]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function ids(store: AiStore) {
  return Object.keys(store.getState().proposals);
}

describe("AI 新建确认卡片", () => {
  it("prepare 和渲染不执行写入，确认保存用户编辑值且只能保存一次，查看只跳转", async () => {
    const { store, execute, validate, prepare, client, api } = setup();
    await render(store);
    await send(store);
    expect(prepare).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("新建备忘录");
    expect(container.textContent).toContain("测试提示：提前提醒已调整");
    await edit("用户改后的标题");
    await click("确认");
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      title: "用户改后的标题",
      content: "原始内容",
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("已保存");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="测试标题"]')!.disabled,
    ).toBe(true);
    await act(async () => {
      await store.getState().confirmProposal(ids(store)[0]!);
    });
    expect(execute).toHaveBeenCalledOnce();
    await click("查看");
    expect(api.openTarget).toHaveBeenCalledExactlyOnceWith(target);
    expect(client.requests).toHaveLength(1);
  });

  it("同步防双击；保存中不能取消、转表单或清空，重挂载仍保存同一卡片", async () => {
    const { store, execute, api, client } = setup();
    const writing = deferred<{ message: string; target: AiTarget }>();
    execute.mockReturnValueOnce(writing.promise);
    await render(store);
    await send(store);
    const id = ids(store)[0]!;
    await act(async () => {
      const confirm = buttons("确认")[0]!;
      confirm.click();
      confirm.click();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ proposalBusy: true });
    await act(async () => {
      store.getState().cancelProposal(id);
      await store.getState().transferProposal(id);
      store.getState().clear();
    });
    expect(store.getState().proposals[id]?.status).toBe("saving");
    expect(api.openCreateForm).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(store);
    expect(buttons("正在保存…")[0]!.disabled).toBe(true);
    expect(buttons("清空对话")[0]!.disabled).toBe(true);
    await act(async () => writing.resolve({ message: "保存完成", target }));
    expect(store.getState().proposals[id]?.status).toBe("saved");
    expect(store.getState().proposalBusy).toBe(false);
    expect(client.requests).toHaveLength(1);
  });

  it("保存失败附原因，不自动重试；重试保存只执行本地写入", async () => {
    const { store, execute, client } = setup();
    execute.mockRejectedValueOnce(new Error("磁盘暂时不可写"));
    await render(store);
    await send(store);
    await edit("失败后也保留这个标题");
    await click("确认");
    expect(container.textContent).toContain("磁盘暂时不可写");
    expect(store.getState().proposals[ids(store)[0]!]!.status).toBe("failed");
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    expect(client.requests).toHaveLength(1);
    await click("重试保存");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0].title).toBe("失败后也保留这个标题");
    expect(container.textContent).toContain("已保存");
    expect(client.requests).toHaveLength(1);
  });

  it("写入方法同步抛错时双击仍只执行一次；查看失败重试也不重新保存", async () => {
    const { store, execute, api, client } = setup();
    execute.mockImplementationOnce(() => {
      throw new Error("同步写入失败");
    });
    await render(store);
    await send(store);
    await act(async () => {
      const confirm = buttons("确认")[0]!;
      confirm.click();
      confirm.click();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("同步写入失败");
    await click("重试保存");
    api.openTarget.mockRejectedValueOnce(new Error("结果暂时无法打开"));
    await click("查看");
    expect(container.textContent).toContain("结果暂时无法打开");
    expect(store.getState().proposals[ids(store)[0]!]!.status).toBe("saved");
    await click("查看");
    expect(api.openTarget).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(client.requests).toHaveLength(1);
  });

  it("校验不通过时只显示纯文本错误；取消后所有写入入口均失效", async () => {
    const { store, validate, execute, api } = setup();
    validate.mockReturnValueOnce(['<img src=x onerror="bad()"> 标题不能为空']);
    await render(store);
    await send(store);
    await click("确认");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("<img");
    expect(container.querySelector("img")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    await edit("可以继续编辑");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("取消");
    const id = ids(store)[0]!;
    expect(store.getState().proposals[id]?.status).toBe("cancelled");
    await act(async () => {
      await store.getState().confirmProposal(id);
      await store.getState().transferProposal(id);
    });
    expect(execute).not.toHaveBeenCalled();
    expect(api.openCreateForm).not.toHaveBeenCalled();
  });

  it("转表单只携带编辑草稿；成功后不可再次确认，转移中状态不随重挂载丢失", async () => {
    const { store, execute, validate, api, client } = setup();
    const transfer = deferred<void>();
    api.openCreateForm.mockReturnValueOnce(transfer.promise);
    await render(store);
    await send(store);
    await edit("送到手动表单的标题");
    await act(async () => {
      const open = buttons("在表单中打开")[0]!;
      open.click();
      open.click();
    });
    const id = ids(store)[0]!;
    expect(api.openCreateForm).toHaveBeenCalledExactlyOnceWith("memos_create", {
      title: "送到手动表单的标题",
      content: "原始内容",
    });
    await act(async () => {
      store.getState().clear();
      root.unmount();
    });
    root = createRoot(container);
    await render(store);
    expect(store.getState().proposals[id]?.status).toBe("transferring");
    expect(buttons("清空对话")[0]!.disabled).toBe(true);
    await act(async () => transfer.resolve());
    expect(container.textContent).toContain("已转到表单");
    await act(async () => {
      await store.getState().confirmProposal(id);
    });
    expect(execute).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(client.requests).toHaveLength(1);
  });

  it("转表单失败保留待确认草稿和原因，可以重试转移或确认", async () => {
    const { store, execute, api, client } = setup();
    api.openCreateForm.mockRejectedValueOnce(new Error("当前备忘录草稿未保存"));
    await render(store);
    await send(store);
    await edit("失败后保留草稿");
    await click("在表单中打开");
    expect(store.getState().proposals[ids(store)[0]!]!.status).toBe("pending");
    expect(container.textContent).toContain("当前备忘录草稿未保存");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="测试标题"]')!.value).toBe(
      "失败后保留草稿",
    );
    expect(execute).not.toHaveBeenCalled();
    await click("在表单中打开");
    expect(api.openCreateForm).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("已转到表单");
    expect(client.requests).toHaveLength(1);
  });

  it("多张卡片独立，草稿、失败原因与本地目标 id 不进入下一次模型上下文", async () => {
    const { store, execute, client } = setup([
      response(3),
      { content: "继续回答", tool_calls: [], usage },
    ]);
    await render(store);
    await send(store);
    await edit("local-private-edited-title", 0);
    const [first, second, third] = ids(store);
    await act(async () => {
      await store.getState().confirmProposal(first!);
      store.getState().cancelProposal(second!);
    });
    expect(store.getState().proposals[first!]?.status).toBe("saved");
    expect(store.getState().proposals[second!]?.status).toBe("cancelled");
    expect(store.getState().proposals[third!]?.status).toBe("pending");
    expect(execute).toHaveBeenCalledOnce();
    await send(store, "再介绍一下");
    const serialized = JSON.stringify(client.requests[1]);
    expect(serialized).not.toContain("local-private-edited-title");
    expect(serialized).not.toContain("local-private-saved-id");
    expect(store.getState().history[0]?.exchanges).toEqual([]);
  });

  it("备注、草稿和保存结果中的 HTML 作为文字显示；模型失败不自动重试", async () => {
    const { store, execute, prepare, client } = setup();
    prepare.mockImplementationOnce(async (draft) => ({
      type: "proposal",
      draft: {
        ...draft,
        content: "<script>bad()</script> **内容**",
      },
      note: "<img src=x> 提醒调整",
    }));
    execute.mockResolvedValueOnce({ message: "<script>结果</script>", target });
    await render(store);
    await send(store);
    expect(container.textContent).toContain("<script>bad()</script> **内容**");
    expect(container.textContent).toContain("<img src=x> 提醒调整");
    expect(container.querySelector("script,img")).toBeNull();
    await click("确认");
    expect(container.textContent).toContain("<script>结果</script>");
    expect(container.querySelector("script,img")).toBeNull();
    expect(client.requests).toHaveLength(1);
    const failed = setup([new AiClientError("NETWORK"), response()]);
    await render(failed.store);
    await send(failed.store);
    expect(failed.client.requests).toHaveLength(1);
    expect(failed.store.getState().proposals).toEqual({});
    expect(failed.execute).not.toHaveBeenCalled();
  });
});
