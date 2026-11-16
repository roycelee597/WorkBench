import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiTargetNavigation } from "../../../workbenches/general/src/ai-navigation";
import { createGeneralAiActions } from "../../../workbenches/general/src/ai-actions";
import { parseAiCreateDraft } from "../../../workbenches/general/src/ai-create-model";
import { createGeneralApi } from "../../../workbenches/general/src/api";
import { createWorkspace } from "../../../workbenches/general/src/workspace-store";
import { parseLocalTime } from "../src/core/ai/local-time";
import { MemoryRefTable } from "../src/core/ai/ref-table";
import type { AiTarget } from "../src/core/ai/action-types";
import { fixture, type MemoryDatabase } from "./memory-database";

const now = Date.parse("2026-11-16T04:00:00Z");
const zone = "Asia/Shanghai";
const active: Array<{ db: MemoryDatabase; workspace: ReturnType<typeof createWorkspace> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { db, workspace } of active.splice(0)) {
    db.failAt = null;
    await workspace.flush();
    db.close();
  }
});
async function setup() {
  const value = await fixture();
  value.clock.now = now;
  const api = createGeneralApi(async () => value.data, { now: () => now, offerAutostart: vi.fn() });
  const workspace = createWorkspace(api);
  active.push({ db: value.db, workspace });
  await workspace.useWorkspace.getState().initialize();
  const open = createAiTargetNavigation(api, workspace);
  const group = createGeneralAiActions(api);
  async function proposal(name: string, args: unknown) {
    const action = group.actions.find((item) => item.name === name)!;
    const prepared = await action.prepare(args, {
      now,
      timezone: zone,
      refs: new MemoryRefTable(),
    });
    if (prepared.type !== "proposal") throw new Error("测试预期得到新建草稿");
    return { action, draft: parseAiCreateDraft(prepared.draft) };
  }
  async function create(name: string, args: unknown): Promise<AiTarget> {
    const { action, draft } = await proposal(name, args);
    const result = await action.execute!(draft);
    if (!result.target) throw new Error("新建结果缺少定位目标");
    return result.target;
  }
  return { ...value, api, workspace, open, proposal, create };
}

describe("AI 新建结果的本地定位", () => {
  it("保存后的日程、提醒和备忘录分别定位正确页面与记录", async () => {
    const { create, open, workspace } = await setup();
    const event = await create("calendar_create_event", {
      title: "组会",
      start: "2026-11-18T15:00",
      remind_before_minutes: null,
    });
    const reminder = await create("reminders_create", { title: "交报告", due: "2026-11-19T10:00" });
    const memo = await create("memos_create", {
      title: "门禁",
      content: "找张老师",
      tags: ["实验室"],
    });
    if (event.kind !== "event" || reminder.kind !== "reminder" || memo.kind !== "memo")
      throw new Error("测试目标类型不符");
    await open(event);
    expect(workspace.useWorkspace.getState()).toMatchObject({
      page: "calendar",
      calendarTarget: {
        series_id: event.eventId,
        original_start_at: parseLocalTime("2026-11-18T15:00", zone),
      },
    });
    await open(reminder);
    expect(workspace.useWorkspace.getState()).toMatchObject({
      page: "reminders",
      reminderTarget: { reminderId: reminder.reminderId },
      reminderCreate: false,
    });
    await open(memo);
    expect(workspace.useWorkspace.getState()).toMatchObject({
      page: "memos",
      selectedId: memo.memoId,
      query: "",
      tag: "",
    });
    expect(
      workspace.useWorkspace.getState().memos.find((row) => row.id === memo.memoId)?.content,
    ).toBe("找张老师");
  });

  it("weekly 的开始日期不在选中星期时定位首个真实实例", async () => {
    const { create, open, workspace } = await setup();
    const target = await create("calendar_create_event", {
      title: "周二四羽毛球",
      start: "2026-11-18T19:00",
      remind_before_minutes: null,
      repeat: { preset: "weekly", weekdays: [2, 4], end: { type: "count", count: 5 } },
    });
    await open(target);
    const occurrence = workspace.useWorkspace.getState().calendarTarget!;
    expect(occurrence.original_start_at).toBe(parseLocalTime("2026-11-19T19:00", zone));
    expect(occurrence.start_at).toBe(occurrence.original_start_at);
    expect(occurrence.event.start_at).toBe(parseLocalTime("2026-11-18T19:00", zone));
  });

  it("支持已有提醒实例定位，错误或已删除的实例不跳页", async () => {
    const { data, create, open, workspace } = await setup();
    const target = await create("reminders_create", { title: "提醒", due: "2026-11-18T10:00" });
    const another = await data.reminders.create({ title: "另一条提醒" });
    if (target.kind !== "reminder") throw new Error("测试目标类型不符");
    const parent = (await data.reminders.get(target.reminderId))!;
    const occurrence = await data.occurrences.ensure(parent, parent.due_at);
    await open({ ...target, occurrenceId: occurrence.id });
    expect(workspace.useWorkspace.getState().reminderTarget).toEqual({
      reminderId: parent.id,
      occurrenceId: occurrence.id,
    });
    await expect(
      open({ kind: "reminder", reminderId: another.id, occurrenceId: occurrence.id }),
    ).rejects.toThrow("这次提醒已不存在");
    await data.occurrences.softDelete(occurrence.id);
    await expect(open({ ...target, occurrenceId: occurrence.id })).rejects.toThrow(
      "这次提醒已不存在",
    );
    expect(workspace.useWorkspace.getState().reminderTarget).toEqual({
      reminderId: parent.id,
      occurrenceId: occurrence.id,
    });
  });

  it("已删除三类记录和不存在的日程实例均拒绝定位", async () => {
    const { data, create, open, workspace } = await setup();
    const event = await create("calendar_create_event", {
      title: "日程",
      start: "2026-11-18T15:00",
      remind_before_minutes: null,
    });
    const reminder = await create("reminders_create", { title: "提醒", due: null });
    const memo = await create("memos_create", { content: "备忘录" });
    if (event.kind !== "event" || reminder.kind !== "reminder" || memo.kind !== "memo")
      throw new Error("测试目标类型不符");
    await expect(
      open({ ...event, originalStart: parseLocalTime("2026-11-19T15:00", zone) }),
    ).rejects.toThrow("这次日程已不存在");
    await data.events.softDelete(event.eventId);
    await data.reminders.softDelete(reminder.reminderId);
    await data.memos.softDelete(memo.memoId);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(open(event)).rejects.toThrow("日程已不存在");
    await expect(open(reminder)).rejects.toThrow("提醒已不存在");
    await expect(open(memo)).rejects.toThrow("操作未完成");
    await expect(open({ kind: "event", eventId: "missing", originalStart: null })).rejects.toThrow(
      "日程已不存在",
    );
    expect(workspace.useWorkspace.getState().page).toBe("today");
  });

  it("定位前 flush 综合备忘录草稿，保存失败不会切页或丢草稿", async () => {
    const { data, api, workspace, open, db } = await setup();
    const memo = await api.createMemoWith({
      title: "草稿",
      content: "原文",
      pinned: false,
      tags: [],
    });
    workspace.acceptCreatedMemo(memo);
    workspace.useWorkspace.getState().editMemo(memo.id, { content: "未保存的新正文" });
    const reminder = await data.reminders.create({ title: "目标提醒" });
    db.failAt = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      open({ kind: "reminder", reminderId: reminder.id, occurrenceId: null }),
    ).rejects.toThrow();
    expect(workspace.useWorkspace.getState().page).toBe("today");
    expect(workspace.useWorkspace.getState().memos.find((row) => row.id === memo.id)?.content).toBe(
      "未保存的新正文",
    );
    expect((await data.memos.get(memo.id))?.content).toBe("原文");
    db.failAt = null;
    await open({ kind: "reminder", reminderId: reminder.id, occurrenceId: null });
    expect((await data.memos.get(memo.id))?.content).toBe("未保存的新正文");
    expect(workspace.useWorkspace.getState().page).toBe("reminders");
  });
});

describe("AI 草稿转交手动新建表单", () => {
  it.each([
    [
      "calendar_create_event",
      { title: "日程", start: "2026-11-18T15:00", remind_before_minutes: null },
      "calendar",
    ],
    ["reminders_create", { title: "提醒", due: null }, "reminders"],
    ["memos_create", { title: "备忘录", content: "尚未保存" }, "memos"],
  ] as const)("%s 只填充表单并切对应页面，不创建任何业务记录", async (name, args, page) => {
    const { data, workspace, proposal } = await setup();
    const { draft } = await proposal(name, args);
    await workspace.useWorkspace.getState().openCreateDraft(name, draft);
    expect(workspace.useWorkspace.getState()).toMatchObject({
      page,
      createDraft: draft,
      reminderCreate: false,
    });
    expect(workspace.useWorkspace.getState().createDraft).not.toBe(draft);
    expect(await data.events.list()).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
    expect(await data.memos.list()).toEqual([]);
  });

  it("草稿类型与操作不符或草稿非法时拒绝转交，页面不变", async () => {
    const { data, workspace, proposal } = await setup();
    const { draft } = await proposal("memos_create", { content: "备忘录" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await workspace.useWorkspace.getState().openCreateDraft("reminders_create", draft);
    expect(workspace.useWorkspace.getState()).toMatchObject({
      page: "today",
      createDraft: null,
      error: expect.stringContaining("操作未完成"),
    });
    await workspace.useWorkspace
      .getState()
      .openCreateDraft("memos_create", { type: "memo", form: { content: "字段不完整" } });
    expect(workspace.useWorkspace.getState().createDraft).toBeNull();
    expect(await data.memos.list()).toEqual([]);
  });

  it("已有新建草稿不被第二张卡片或保存结果的查看覆盖", async () => {
    const { data, workspace, proposal, open } = await setup();
    const first = await proposal("memos_create", { title: "第一张卡片", content: "原草稿" });
    const next = await proposal("reminders_create", { title: "第二张卡片", due: null });
    await workspace.useWorkspace.getState().openCreateDraft("memos_create", first.draft);
    const existing = workspace.useWorkspace.getState().createDraft;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await workspace.useWorkspace.getState().openCreateDraft("reminders_create", next.draft);
    expect(workspace.useWorkspace.getState().createDraft).toBe(existing);
    expect(workspace.useWorkspace.getState().page).toBe("memos");
    await expect(open({ kind: "memo", memoId: "any-target" })).rejects.toThrow("请先保存或关闭");
    expect(workspace.useWorkspace.getState().createDraft).toBe(existing);
    expect(await data.memos.list()).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
  });
});
