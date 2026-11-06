// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, type MemoryDatabase } from "../../../apps/desktop/tests/memory-database";
import { createGeneralApi } from "../src/api";
import { createWorkspace } from "../src/workspace-store";
import { localDayRange } from "../src/today-model";
const databases: MemoryDatabase[] = [];
async function setup() {
  const value = await fixture();
  databases.push(value.db);
  const offer = vi.fn();
  const api = createGeneralApi(async () => value.data, {
    now: () => value.clock.now,
    offerAutostart: offer,
  });
  return { ...value, api, offer };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
describe("快速新建数据入口", () => {
  it("三种类型通过现有仓库持久化，日程读默认提前量并同步提醒，首次时间提醒只提示一次", async () => {
    const { api, data, clock, offer } = await setup();
    const memo = await api.quickCreate({
      type: "memo",
      title: "速记",
      content: "## **重点**\n\n- [x] 完成",
    });
    expect(memo.type).toBe("memo");
    expect((await data.memos.get(memo.record.id))?.content).toContain("- [x]");
    await api.setDefaultEventReminder(10);
    const event = await api.quickCreate({
      type: "event",
      title: "会议",
      notes: "备注",
      start_at: clock.now + 3_600_000,
      end_at: clock.now + 7_200_000,
      all_day: false,
      timezone: "UTC",
    });
    expect(await data.events.get(event.record.id)).toMatchObject({ remind_before_minutes: 10 });
    expect((await data.reminders.list())[0]).toMatchObject({
      source: "event",
      due_at: clock.now + 3_000_000,
    });
    const todo = await api.quickCreate({
      type: "reminder",
      title: "待办",
      notes: "",
      due_at: null,
      timezone: "UTC",
    });
    expect(await data.reminders.get(todo.record.id)).toMatchObject({
      due_at: null,
      source: "manual",
    });
    await api.quickCreate({
      type: "reminder",
      title: "到点",
      notes: "",
      due_at: clock.now + 1000,
      timezone: "UTC",
    });
    expect(offer).toHaveBeenCalledOnce();
  });
  it("空标题正文、反向时间、伪造来源或未知类型均拒绝且不产生记录", async () => {
    const { api, data, clock } = await setup();
    const event = {
      type: "event",
      title: "日程",
      notes: "",
      start_at: clock.now,
      end_at: clock.now - 1,
      all_day: false,
      timezone: "UTC",
    };
    for (const input of [
      event,
      { type: "memo", title: " ", content: " " },
      { type: "memo", title: "X", content: "", source_workbench: "evil" },
      { type: "other" },
      { type: "reminder", title: "", notes: "", due_at: null, timezone: "UTC" },
    ])
      await expect(api.quickCreate(input)).rejects.toThrow();
    expect(await data.memos.list()).toEqual([]);
    expect(await data.events.list()).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
  });
  it("写入失败保留事务原状；空标题备忘可以用正文命名", async () => {
    const { api, data, db } = await setup();
    db.failAt = 0;
    await expect(
      api.quickCreate({ type: "memo", title: "失败", content: "输入" }),
    ).rejects.toThrow();
    db.failAt = null;
    expect(await data.memos.list()).toEqual([]);
    await api.quickCreate({ type: "memo", title: "", content: "# 无标题正文" });
    expect((await data.memos.list())[0]?.content).toBe("# 无标题正文");
  });
  it("快捷键配置持久化并校验，快速窗口偏好不返回其他设置", async () => {
    const { api, data } = await setup();
    expect(await api.getStoredShortcut()).toBe("Ctrl+Alt+N");
    await api.setStoredShortcut("Ctrl+Shift+K");
    expect(await api.getStoredShortcut()).toBe("Ctrl+Shift+K");
    await expect(api.setStoredShortcut("N")).rejects.toThrow();
    await data.settings.setValue("theme", "dark");
    await api.setDefaultEventReminder(5);
    expect(await api.quickPreferences()).toEqual({ theme: "dark", defaultReminder: 5 });
  });
  it("今天页跳转清空备忘录筛选并定位日程，快速新增不会覆盖主窗口未保存草稿", async () => {
    const { api, data, clock } = await setup();
    const workspace = createWorkspace(api);
    const state = () => workspace.useWorkspace.getState();
    await state().initialize();
    await state().createMemo();
    const draftId = state().selectedId!;
    state().editMemo(draftId, { title: "未保存草稿" });
    const saved = await api.quickCreate({ type: "memo", title: "快速新增", content: "另一个窗口" });
    if (saved.type !== "memo") throw new Error("错误类型");
    workspace.acceptCreatedMemo(saved.record);
    expect(state().memos.find((row) => row.id === draftId)?.title).toBe("未保存草稿");
    state().setQuery("不匹配");
    state().setTag("隐藏");
    await state().openMemo(saved.record.id);
    expect(state()).toMatchObject({
      page: "memos",
      selectedId: saved.record.id,
      query: "",
      tag: "",
    });
    expect((await data.memos.get(draftId))?.title).toBe("未保存草稿");
    const { start } = localDayRange(clock.now);
    await data.events.create({
      title: "定位",
      start_at: start + 1000,
      end_at: start + 2000,
      timezone: "UTC",
    });
    const occurrence = (await api.loadToday(clock.now)).events[0]!;
    await state().openCalendar(occurrence);
    expect(state()).toMatchObject({
      page: "calendar",
      calendarTarget: occurrence,
      calendarNavigationVersion: 1,
    });
  });
});
