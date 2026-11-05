// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, type MemoryDatabase } from "../../../apps/desktop/tests/memory-database";
import { createGeneralApi } from "../src/api";
import { createWorkspace } from "../src/workspace-store";

const databases: MemoryDatabase[] = [];
async function setup() {
  const value = await fixture();
  databases.push(value.db);
  const api = createGeneralApi(async () => value.data);
  const workspace = createWorkspace(api);
  return { ...value, api, workspace, state: () => workspace.useWorkspace.getState() };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
describe("工作台编辑状态", () => {
  it("提醒定位、托盘新建和错过汇总跳转前保存备忘录，并刷新通知目标", async () => {
    const { state, data } = await setup();
    await state().initialize();
    await state().createMemo();
    const id = state().selectedId!;
    state().editMemo(id, { title: "跳转前保存" });
    const target = { reminderId: "reminder", occurrenceId: "occurrence" };
    await state().openReminder(target);
    expect((await data.memos.get(id))?.title).toBe("跳转前保存");
    expect(state()).toMatchObject({
      page: "reminders",
      reminderTarget: target,
      reminderNavigationVersion: 1,
    });
    await state().newReminder();
    expect(state()).toMatchObject({
      page: "reminders",
      reminderCreate: true,
      reminderTarget: null,
      reminderNavigationVersion: 2,
    });
    await state().openMissed(2);
    expect(state()).toMatchObject({
      page: "today",
      missedCount: 2,
      reminderCreate: false,
      reminderTarget: null,
    });
  });
  it("提醒导航保存失败保留当前页与输入，修复后才能打开今天汇总", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state, db } = await setup();
    await state().initialize();
    await state().createMemo();
    state().editMemo(state().selectedId!, { title: "不能丢失" });
    db.failAt = 0;
    await state().openMissed(2);
    expect(state()).toMatchObject({ page: "memos", missedCount: 0, saveStatus: "error" });
    expect(state().memos[0]?.title).toBe("不能丢失");
    db.failAt = null;
    await state().openMissed(2);
    expect(state()).toMatchObject({ page: "today", missedCount: 2 });
  });
  it("新建、切换页签和切换记录前会保存，回收站操作刷新列表", async () => {
    const { workspace, state, data } = await setup();
    await state().initialize();
    expect(state().page).toBe("today");
    await state().createMemo();
    const first = state().selectedId!;
    state().editMemo(first, { title: "第一条", content: "**加粗**" });
    await state().createMemo();
    const second = state().selectedId!;
    expect((await data.memos.get(first))?.content).toBe("**加粗**");
    state().editMemo(second, { title: "第二条" });
    await state().selectMemo(first);
    expect((await data.memos.get(second))?.title).toBe("第二条");
    state().editMemo(first, { content: "新正文" });
    await state().navigate("settings");
    expect((await data.memos.get(first))?.content).toBe("新正文");
    await state().deleteMemo(first);
    await state().navigate("trash");
    expect(state().deleted.map((row) => row.id)).toEqual([first]);
    await state().restoreMemo(first);
    expect(state().deleted).toEqual([]);
    expect(state().memos).toHaveLength(2);
    await state().deleteMemo(first);
    await state().purgeMemo(first);
    expect(state().deleted).toEqual([]);
    await workspace.flush();
  });
  it("失败时阻止切换并保留草稿，重试 flush 后才能安全离开", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { workspace, state, db, data } = await setup();
    await state().initialize();
    await state().createMemo();
    const id = state().selectedId!;
    state().editMemo(id, { title: "未保存输入" });
    db.failAt = 0;
    await state().navigate("today");
    expect(state().page).toBe("memos");
    expect(state().saveStatus).toBe("error");
    expect(state().memos[0]?.title).toBe("未保存输入");
    await expect(workspace.flush()).rejects.toThrow();
    db.failAt = null;
    await state().navigate("today");
    expect(state().page).toBe("today");
    expect((await data.memos.get(id))?.title).toBe("未保存输入");
  });
  it("初始化失败可重试，重复初始化共用一次加载", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { api } = await setup();
    const load = vi.spyOn(api, "load").mockRejectedValueOnce(new Error("读取失败"));
    const workspace = createWorkspace(api);
    await workspace.useWorkspace.getState().initialize();
    expect(workspace.useWorkspace.getState().ready).toBe(false);
    await Promise.all([
      workspace.useWorkspace.getState().initialize(),
      workspace.useWorkspace.getState().initialize(),
    ]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(workspace.useWorkspace.getState().ready).toBe(true);
  });
});
