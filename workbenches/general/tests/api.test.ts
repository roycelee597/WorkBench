// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  createGeneralApi,
  filterMemos,
  knownTags,
  memoTitle,
  normalizeTags,
  type Theme,
} from "../src/api";
import { fixture, type MemoryDatabase } from "../../../apps/desktop/tests/memory-database";

const databases: MemoryDatabase[] = [];
async function setup() {
  const value = await fixture();
  databases.push(value.db);
  return { ...value, api: createGeneralApi(async () => value.data) };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
describe("综合工作台数据入口", () => {
  it("新建、保存及标签规范化通过仓库持久化 Markdown", async () => {
    const { api, data, clock } = await setup();
    const memo = await api.createMemo();
    clock.now += 500;
    const source = "## 小结\n\n- [x] **已完成**";
    const saved = await api.saveMemo(memo.id, {
      title: "周计划",
      content: source,
      pinned: true,
      tags: [" 工作 ", "工作", "Work", "work", ""],
    });
    expect(await data.memos.get(memo.id)).toEqual(saved);
    expect(saved).toMatchObject({
      content: source,
      tags: ["工作", "Work"],
      pinned: true,
      updated_at: clock.now,
    });
    expect((await api.load()).memos).toEqual([saved]);
  });
  it("搜索标题、渲染正文、标签不区分大小写，标签筛选可叠加且排序稳定", async () => {
    const { data, clock } = await setup();
    const oldest = await data.memos.create({
      title: "Release",
      content: "普通正文",
      tags: ["Work"],
    });
    clock.now++;
    const recent = await data.memos.create({
      title: "最近",
      content: "Work**Bench** 正文",
      tags: ["学习"],
    });
    clock.now++;
    const pinned = await data.memos.create({
      title: "置顶",
      content: "另外",
      tags: ["Work"],
      pinned: true,
    });
    const rows = [oldest, recent, pinned];
    expect(filterMemos(rows).map((row) => row.id)).toEqual([pinned.id, recent.id, oldest.id]);
    expect(filterMemos(rows, { query: "reLEASE" }).map((row) => row.id)).toEqual([oldest.id]);
    expect(filterMemos(rows, { query: "workbench" }).map((row) => row.id)).toEqual([recent.id]);
    expect(filterMemos(rows, { query: "WORK", tag: "work" }).map((row) => row.id)).toEqual([
      pinned.id,
      oldest.id,
    ]);
    expect(filterMemos(rows, { query: "release", tag: "学习" })).toEqual([]);
    expect(rows.map((row) => row.id)).toEqual([oldest.id, recent.id, pinned.id]);
    expect(
      filterMemos([
        { ...oldest, deleted_at: 1 },
        { ...recent, purged_at: 2 },
      ]),
    ).toEqual([]);
  });
  it("无标题时显示正文首行，补全标签去重且排除删除记录", async () => {
    const { data } = await setup();
    const one = await data.memos.create({
      title: " ",
      content: "\n## **正文标题**\n\n后续正文",
      tags: [" 工作 ", "Work"],
    });
    const two = await data.memos.create({ tags: ["work", "学习"] });
    const deleted = { ...two, deleted_at: 1, tags: ["隐藏"] };
    expect(memoTitle(one)).toBe("正文标题");
    expect(memoTitle(two)).toBe("未命名备忘录");
    expect(knownTags([one, two, deleted])).toEqual(
      expect.arrayContaining(["工作", "Work", "学习"]),
    );
    expect(knownTags([one, two, deleted])).not.toContain("隐藏");
    expect(normalizeTags([" a ", "A", "b", ""])).toEqual(["a", "b"]);
  });
  it("软删除后只进入回收站，恢复保留内容，永久删除保留不可恢复墓碑", async () => {
    const { api, data, db } = await setup();
    const memo = await data.memos.create({ title: "待回收", content: "正文", tags: ["标签"] });
    await api.deleteMemo(memo.id);
    expect((await api.load()).memos).toEqual([]);
    expect(await api.listDeleted()).toEqual([
      expect.objectContaining({ id: memo.id, content: "正文" }),
    ]);
    await api.restoreMemo(memo.id);
    expect((await api.load()).memos[0]?.content).toBe("正文");
    await api.deleteMemo(memo.id);
    await api.purgeMemo(memo.id);
    expect(await api.listDeleted()).toEqual([]);
    expect(
      (
        await db.select(
          "SELECT id, title, content, tags, deleted_at, purged_at FROM memos WHERE id = ?",
          [memo.id],
        )
      )[0],
    ).toMatchObject({
      id: memo.id,
      title: "",
      content: "",
      tags: "[]",
      deleted_at: expect.any(Number),
      purged_at: expect.any(Number),
    });
    await expect(api.restoreMemo(memo.id)).rejects.toThrow();
  });
  it("默认跟随系统，主题存入 settings，未知配置安全回退", async () => {
    const { api, data } = await setup();
    expect((await api.load()).theme).toBe("system");
    for (const theme of ["light", "dark", "system"] as const) {
      await api.setTheme(theme);
      expect(await data.settings.getValue("theme")).toBe(theme);
      expect((await api.load()).theme).toBe(theme);
    }
    await data.settings.setValue("theme", "unexpected");
    expect((await api.load()).theme).toBe("system");
    await expect(api.setTheme("unexpected" as Theme)).rejects.toThrow("主题");
  });
  it("数据读取或写入失败向调用层传播，不伪装为保存成功", async () => {
    const { api, data, db } = await setup();
    const memo = await data.memos.create();
    db.failAt = 0;
    await expect(
      api.saveMemo(memo.id, { title: "不应写入", content: "", tags: [], pinned: false }),
    ).rejects.toThrow();
    expect((await data.memos.get(memo.id))?.title).toBe("");
    const failed = createGeneralApi(async () => {
      throw new Error("离线失败");
    });
    await expect(failed.load()).rejects.toThrow("离线失败");
  });
  it("日历入口展开例外并同步关联提醒，删除/恢复/清空通过仓库执行", async () => {
    const { api, data, db } = await setup();
    const start = Date.parse("2026-11-02T09:00Z");
    const range = { start, end: start + 7 * 86_400_000 };
    const series = await api.createEvent({
      title: "计划",
      start_at: start,
      end_at: start + 3_600_000,
      timezone: "UTC",
      rrule: "FREQ=DAILY;COUNT=3",
      remind_before_minutes: 10,
    });
    expect((await api.loadCalendar(range)).occurrences).toHaveLength(3);
    await api.editEventOccurrence(series.id, start + 86_400_000, "this", {
      title: "特别安排",
      start_at: start + 86_400_000 + 3_600_000,
    });
    const rows = (await api.loadCalendar(range)).occurrences;
    expect(rows.map((row) => row.event.title)).toEqual(["计划", "特别安排", "计划"]);
    expect(await data.reminders.list()).toHaveLength(2);
    await api.deleteEventOccurrence(series.id, start, "all");
    expect((await api.loadCalendar(range)).occurrences).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
    expect(await api.listDeletedEvents()).toHaveLength(2);
    await api.restoreEvent(series.id);
    expect((await api.loadCalendar(range)).occurrences).toHaveLength(3);
    expect(await data.reminders.list()).toHaveLength(2);
    await api.deleteEvent(series.id);
    await api.purgeEvent(series.id);
    expect(await api.listDeletedEvents()).toEqual([]);
    expect(
      (
        await db.select("SELECT title, deleted_at, purged_at FROM events WHERE id = ?", [series.id])
      )[0],
    ).toMatchObject({ title: "", deleted_at: expect.any(Number), purged_at: expect.any(Number) });
  });
  it("日程默认提前提醒初始为空，配置持久化，未知值回退；编辑普通日程同步提醒", async () => {
    const { api, data } = await setup();
    const start = Date.parse("2026-11-02T09:00Z");
    expect(await api.getDefaultEventReminder()).toBeNull();
    expect((await api.loadCalendar({ start, end: start + 1 })).defaultReminder).toBeNull();
    for (const value of [0, 5, 10, 15, 30, 60, 1440, null]) {
      await api.setDefaultEventReminder(value);
      expect(await api.getDefaultEventReminder()).toBe(value);
      expect(await data.settings.getValue("default_event_remind")).toBe(value);
    }
    await expect(api.setDefaultEventReminder(9)).rejects.toThrow("无效");
    await data.settings.setValue("default_event_remind", "10");
    expect(await api.getDefaultEventReminder()).toBeNull();
    const one = await api.createEvent({
      title: "会议",
      start_at: start,
      end_at: start + 3_600_000,
      remind_before_minutes: 0,
    });
    await api.updateEvent(one.id, {
      title: "调整会议",
      start_at: start + 3_600_000,
      end_at: start + 7_200_000,
    });
    expect((await data.reminders.list())[0]).toMatchObject({
      title: "调整会议",
      source: "event",
      event_id: one.id,
      due_at: start + 3_600_000,
    });
  });
});
