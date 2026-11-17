// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiWorkbench } from "../../../workbenches/ai/src/AiWorkbench";
import { createAiStore } from "../../../workbenches/ai/src/ai-store";
import { createGeneralApi } from "../../../workbenches/general/src/api";
import { createGeneralAiActions } from "../../../workbenches/general/src/ai-actions";
import { AiRegistry } from "../src/core/ai/registry";
import type { AiKeyStatus, LlmResponse } from "../src/core/ai/llm-client";
import { parseLocalTime } from "../src/core/ai/local-time";
import { fixture, type MemoryDatabase } from "./memory-database";
import { MockLlmClient } from "./mock-llm-client";

const now = Date.parse("2026-11-16T04:00:00Z");
const zone = "Asia/Shanghai";
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
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
let root: Root;
let container: HTMLDivElement;
const databases: MemoryDatabase[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("TZ", zone);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const call = (name: string, args: unknown, id = name) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
function response(calls: LlmResponse["tool_calls"], content: string | null = null): LlmResponse {
  return { content, tool_calls: calls, usage };
}
function button(scope: ParentNode, text: string) {
  const result = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!result) throw new Error(`找不到按钮：${text}`);
  return result;
}
function card(name: string) {
  const result = container.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  if (!result) throw new Error(`找不到卡片：${name}`);
  return result;
}
function field(scope: ParentNode, name: string) {
  const label = [...scope.querySelectorAll("label")].find(
    (item) =>
      [...item.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("")
        .trim() === name,
  );
  const result = label?.control;
  if (!(result instanceof HTMLInputElement || result instanceof HTMLTextAreaElement))
    throw new Error(`找不到字段：${name}`);
  return result;
}
async function edit(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(scope: ParentNode, text: string) {
  await act(async () => button(scope, text).click());
}
async function setup(reply: LlmResponse) {
  const value = await fixture();
  databases.push(value.db);
  value.clock.now = now;
  const api = createGeneralApi(async () => value.data, { now: () => now, offerAutostart: vi.fn() });
  const registry = new AiRegistry();
  registry.register(createGeneralAiActions(api));
  const client = new MockLlmClient([reply]);
  const conversationApi = {
    keyStatus: async () => key,
    loadModel: async () => "deepseek-flash" as const,
    chat: client.chat.bind(client),
  };
  let id = 0;
  const store = createAiStore(conversationApi, {
    registry,
    now: () => now,
    newId: () => `message-${++id}`,
  });
  await act(async () =>
    root.render(
      <AiWorkbench store={store} openSettings={vi.fn()} manualCreate={vi.fn()} focusVersion={1} />,
    ),
  );
  await edit(
    container.querySelector<HTMLTextAreaElement>("#ai-composer")!,
    "根据这句话生成待确认的新建卡片",
  );
  await click(container, "发送");
  expect(store.getState().pending).toBe(false);
  return { ...value, api, registry, client, store };
}

describe("AI 新建真实组合流程", () => {
  it("真实卡片编辑标题与起止时间后双击确认，只写一条日程并原子生成提前提醒", async () => {
    const { data, api, store, client } = await setup(
      response([
        call("calendar_create_event", {
          title: "和导师开会",
          start: "2026-11-18T15:00",
          end: "2026-11-18T16:00",
          remind_before_minutes: 30,
        }),
      ]),
    );
    const createEvent = vi.spyOn(api, "createEvent");
    const eventCard = card("新建日程");
    expect(await data.events.list()).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
    await edit(field(eventCard, "标题"), "改成课题讨论");
    await edit(field(eventCard, "开始"), "2026-11-19T16:00");
    await edit(field(eventCard, "结束"), "2026-11-19T17:30");
    await act(async () => {
      const confirm = button(eventCard, "确认");
      confirm.click();
      confirm.click();
    });
    const rows = await data.events.list();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      title: "改成课题讨论",
      start_at: parseLocalTime("2026-11-19T16:00", zone),
      end_at: parseLocalTime("2026-11-19T17:30", zone),
      timezone: zone,
      source_workbench: "com.royce.workbench.ai",
      remind_before_minutes: 30,
    });
    const reminders = await data.reminders.list();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      title: row.title,
      event_id: row.id,
      source: "event",
      due_at: row.start_at - 30 * 60_000,
    });
    expect(createEvent).toHaveBeenCalledOnce();
    expect(Object.values(store.getState().proposals)[0]?.status).toBe("saved");
    expect(eventCard.querySelector('[role="status"]')?.textContent).toBe("已保存");
    expect(field(eventCard, "标题").closest("fieldset")?.disabled).toBe(true);
    expect(client.requests).toHaveLength(1);
  });

  it("日程和提醒事务中途失败整批回滚，修复后重试保存只访问本地、不再调用模型", async () => {
    const { db, data, api, store, client } = await setup(
      response([
        call("calendar_create_event", {
          title: "事务验证",
          start: "2026-11-18T15:00",
          remind_before_minutes: 15,
        }),
      ]),
    );
    const createEvent = vi.spyOn(api, "createEvent");
    const eventCard = card("新建日程");
    await edit(field(eventCard, "标题"), "失败后保留的标题");
    db.failAt = 1;
    await click(eventCard, "确认");
    expect(eventCard.querySelector('[role="status"]')?.textContent).toBe("保存失败");
    expect(eventCard.querySelector('[role="alert"]')?.textContent).toContain("模拟事务失败");
    expect(Object.values(store.getState().proposals)[0]?.status).toBe("failed");
    expect(await db.select<{ count: number }>("SELECT COUNT(*) AS count FROM events")).toEqual([
      { count: 0 },
    ]);
    expect(await db.select<{ count: number }>("SELECT COUNT(*) AS count FROM reminders")).toEqual([
      { count: 0 },
    ]);
    expect(field(eventCard, "标题").value).toBe("失败后保留的标题");
    expect(client.requests).toHaveLength(1);
    db.failAt = null;
    await click(eventCard, "重试保存");
    expect((await data.events.list()).map((item) => item.title)).toEqual(["失败后保留的标题"]);
    expect(await data.reminders.list()).toHaveLength(1);
    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(client.requests).toHaveLength(1);
    expect(eventCard.querySelector('[role="status"]')?.textContent).toBe("已保存");
  });

  it("多卡独立取消备忘录、确认提醒，HTML载荷始终是文字且只保存已确认的条目", async () => {
    const memoTitle = '<img src=x onerror="bad()">备忘录';
    const memoContent = "<script>window.bad = true</script>实验室门禁找张老师";
    const modelText = "<script>模型文字</script> **请核对卡片**";
    const { data, client, store } = await setup(
      response(
        [
          call("memos_create", { title: memoTitle, content: memoContent }),
          call("reminders_create", { title: "交实验报告", due: "2026-11-17T15:00", priority: 2 }),
        ],
        modelText,
      ),
    );
    const memoCard = card("新建备忘录");
    const reminderCard = card("新建提醒");
    expect(container.textContent).toContain(modelText);
    expect(memoCard.textContent).toContain(memoTitle);
    expect(field(memoCard, "正文").value).toBe(memoContent);
    expect(container.querySelector("script,img")).toBeNull();
    expect(await data.memos.list()).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
    await click(memoCard, "取消");
    expect(memoCard.querySelector('[role="status"]')?.textContent).toBe("已取消");
    expect(reminderCard.querySelector('[role="status"]')?.textContent).toBe("待确认");
    await click(reminderCard, "确认");
    expect(await data.events.list()).toEqual([]);
    expect(await data.memos.list()).toEqual([]);
    const reminders = await data.reminders.list();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      title: "交实验报告",
      priority: 2,
      due_at: parseLocalTime("2026-11-17T15:00", zone),
      source: "manual",
      source_workbench: "com.royce.workbench.ai",
    });
    expect(Object.values(store.getState().proposals).map((item) => item.status)).toEqual([
      "cancelled",
      "saved",
    ]);
    expect(container.querySelector("script,img")).toBeNull();
    expect(client.requests).toHaveLength(1);
  });
});
