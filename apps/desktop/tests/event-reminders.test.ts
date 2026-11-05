import { afterEach, describe, expect, it } from "vitest";
import { expandEventReminders } from "../src/core/calendar/event-reminders";
import { expandEvents } from "../src/core/calendar/recurrence";
import { fixture, type MemoryDatabase } from "./memory-database";

const databases: MemoryDatabase[] = [];
const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 5, 9);
async function setup() {
  const value = await fixture();
  databases.push(value.db);
  const root = await value.data.events.create({
    title: "学习",
    notes: "读两页",
    start_at: start,
    end_at: start + 3_600_000,
    timezone: "UTC",
    rrule: "FREQ=DAILY;COUNT=5",
    remind_before_minutes: 10,
  });
  return { ...value, root };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});

describe("日程和提前提醒的原子联动", () => {
  it("默认无提醒，启用后创建，改标题备注和时间同步，取消只删除自动提醒", async () => {
    const { db, data, root } = await setup();
    const plain = await data.events.create({
      title: "不提醒",
      start_at: start,
      end_at: start + 1000,
    });
    expect((await data.reminders.list()).some((row) => row.event_id === plain.id)).toBe(false);
    const first = (await data.reminders.list())[0]!;
    expect(first).toMatchObject({
      event_id: root.id,
      source: "event",
      title: root.title,
      notes: root.notes,
      due_at: start - 600_000,
      rrule: root.rrule,
    });
    const manual = await data.reminders.create({ title: "手动关联", event_id: root.id });
    await data.events.update(root.id, {
      title: "改标题",
      notes: "改备注",
      start_at: start + 60_000,
      end_at: root.end_at + 60_000,
    });
    expect(await data.reminders.get(first.id)).toMatchObject({
      title: "改标题",
      notes: "改备注",
      due_at: start - 540_000,
    });
    await data.events.update(root.id, { remind_before_minutes: null });
    expect(await data.reminders.get(first.id)).toBeNull();
    expect(await data.reminders.get(manual.id)).not.toBeNull();
    await data.events.update(root.id, { remind_before_minutes: 0 });
    const active = (await data.reminders.list()).filter((row) => row.source === "event");
    expect(active).toHaveLength(1);
    expect(active[0]?.due_at).toBe(start + 60_000);
    expect(
      (
        await db.select<{ count: number }>(
          "SELECT count(*) AS count FROM reminders WHERE id = ? AND deleted_at IS NOT NULL",
          [first.id],
        )
      )[0]?.count,
    ).toBe(1);
  });
  it("更改排期清空通知/完成状态，单改文案保留状态和提醒 id", async () => {
    const { data, root } = await setup();
    const reminder = (await data.reminders.list())[0]!;
    await data.reminders.update(reminder.id, {
      completed_at: 10,
      notified_at: 11,
      snooze_until: 12,
    });
    await data.events.update(root.id, { title: "新文案" });
    expect(await data.reminders.get(reminder.id)).toMatchObject({
      completed_at: 10,
      notified_at: 11,
      snooze_until: 12,
    });
    await data.events.update(root.id, { remind_before_minutes: 15 });
    expect(await data.reminders.get(reminder.id)).toMatchObject({
      completed_at: null,
      notified_at: null,
      snooze_until: null,
      due_at: start - 900_000,
    });
  });
  it("创建或更新关联提醒失败时，日程也回滚", async () => {
    const { data, db, root } = await setup();
    db.failAt = 1;
    await expect(
      data.events.create({
        title: "失败创建",
        start_at: start,
        end_at: start + 1000,
        remind_before_minutes: 0,
      }),
    ).rejects.toThrow();
    expect((await data.events.list()).map((row) => row.title)).not.toContain("失败创建");
    await expect(data.events.update(root.id, { title: "失败修改" })).rejects.toThrow();
    expect((await data.events.get(root.id))?.title).toBe(root.title);
  });
  it("仅此次改动创建例外提醒，原系列排除该次，移动例外按实际时间提醒", async () => {
    const { data, root } = await setup();
    await data.events.editOccurrence(root.id, start + DAY, "this", {
      title: "单次",
      start_at: start + DAY + 7_200_000,
      end_at: start + DAY + 10_800_000,
      remind_before_minutes: 5,
    });
    const rows = await data.events.list();
    const exception = rows.find((row) => row.recurrence_id === root.id)!;
    expect(exception).toMatchObject({ original_start_at: start + DAY, title: "单次" });
    expect(
      (await data.reminders.list()).find((row) => row.event_id === exception.id),
    ).toMatchObject({ rrule: null, due_at: exception.start_at - 300_000, source: "event" });
    const due = expandEventReminders(rows, await data.reminders.list(), {
      start: start - DAY,
      end: start + 6 * DAY,
    });
    expect(due).toHaveLength(5);
    expect(due.filter((row) => row.occurrence.original_start_at === start + DAY)).toEqual([
      expect.objectContaining({ due_at: exception.start_at - 300_000 }),
    ]);
  });
  it("仅此次删除遵守 EXDATE；例外取消提醒只影响此次", async () => {
    const { data, root } = await setup();
    await data.events.editOccurrence(root.id, start + DAY, "this", { remind_before_minutes: null });
    await data.events.deleteOccurrence(root.id, start + 2 * DAY, "this");
    const due = expandEventReminders(await data.events.list(), await data.reminders.list(), {
      start: start - DAY,
      end: start + 6 * DAY,
    });
    expect(due.map((row) => row.occurrence.original_start_at)).toEqual([
      start,
      start + 3 * DAY,
      start + 4 * DAY,
    ]);
  });
  it("此后全部截断旧提醒、创建新系列提醒并迁移例外", async () => {
    const { data, root } = await setup();
    await data.events.editOccurrence(root.id, start + 3 * DAY, "this", { title: "未来例外" });
    const exception = (await data.events.list()).find((row) => row.recurrence_id === root.id)!;
    await data.events.editOccurrence(root.id, start + 2 * DAY, "following", {
      title: "未来",
      start_at: start + 2 * DAY + 3_600_000,
      end_at: start + 2 * DAY + 7_200_000,
    });
    const events = await data.events.list();
    const future = events.find((row) => row.recurrence_id === null && row.id !== root.id)!;
    expect(future.rrule).toContain("COUNT=3");
    expect(events.find((row) => row.id === exception.id)?.recurrence_id).toBe(future.id);
    const reminders = await data.reminders.list();
    expect(reminders.find((row) => row.event_id === root.id)?.rrule).toContain("UNTIL=");
    expect(reminders.find((row) => row.event_id === future.id)?.title).toBe("未来");
    expect(
      expandEventReminders(events, reminders, { start: start - DAY, end: start + 6 * DAY }),
    ).toHaveLength(5);
  });
  it("全部移动相邻例外不会触碰唯一索引，保持例外实际时间并同步提醒", async () => {
    const { data, root } = await setup();
    for (const day of [1, 2])
      await data.events.editOccurrence(root.id, start + day * DAY, "this", { title: `例外${day}` });
    const before = (await data.events.list()).filter((row) => row.recurrence_id !== null);
    await data.events.editOccurrence(root.id, start, "all", {
      start_at: start + DAY,
      end_at: root.end_at + DAY,
    });
    const after = (await data.events.list()).filter((row) => row.recurrence_id !== null);
    expect(after.map((row) => row.start_at)).toEqual(before.map((row) => row.start_at));
    expect(after.map((row) => row.original_start_at)).toEqual(
      before.map((row) => row.original_start_at! + DAY),
    );
    expect(
      expandEventReminders(await data.events.list(), await data.reminders.list(), {
        start,
        end: start + 7 * DAY,
      }),
    ).toHaveLength(5);
  });
  it("删除全部及恢复按删除组联动提醒，独立删除的提醒不复活", async () => {
    const { data, root } = await setup();
    await data.events.editOccurrence(root.id, start + DAY, "this", { title: "例外" });
    const independent = await data.reminders.create({ title: "以前删除的", event_id: root.id });
    await data.reminders.softDelete(independent.id);
    await data.events.deleteOccurrence(root.id, start, "all");
    expect(await data.events.list()).toEqual([]);
    expect(await data.reminders.list()).toEqual([]);
    await data.events.restore(root.id);
    expect(await data.events.list()).toHaveLength(2);
    expect(await data.reminders.list()).toHaveLength(2);
    expect(await data.reminders.get(independent.id)).toBeNull();
    await data.events.softDelete(root.id);
    await data.events.purgeContent(root.id);
    expect(await data.events.listDeleted()).toEqual([]);
    await expect(data.events.restore(root.id)).rejects.toThrow();
  });
  it("此后删除截断原系列，未来例外和其提醒可单独恢复", async () => {
    const { data, root } = await setup();
    await data.events.editOccurrence(root.id, start + 3 * DAY, "this", { title: "未来例外" });
    const exception = (await data.events.list()).find((row) => row.recurrence_id !== null)!;
    await data.events.deleteOccurrence(root.id, start + 2 * DAY, "following");
    expect(
      expandEventReminders(await data.events.list(), await data.reminders.list(), {
        start: start - DAY,
        end: start + 6 * DAY,
      }),
    ).toHaveLength(2);
    await data.events.restore(exception.id);
    expect((await data.reminders.list()).some((row) => row.event_id === exception.id)).toBe(true);
  });
  it("跨午夜提前量不会把每周提醒错移一天，范围为半开区间", async () => {
    const { data } = await setup();
    const sunday = Date.UTC(2026, 0, 11, 0, 5);
    const weekly = await data.events.create({
      title: "周日凌晨",
      start_at: sunday,
      end_at: sunday + 60_000,
      timezone: "UTC",
      rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=2",
      remind_before_minutes: 10,
    });
    const events = (await data.events.list()).filter((row) => row.id === weekly.id);
    const reminders = (await data.reminders.list()).filter((row) => row.event_id === weekly.id);
    expect(
      expandEventReminders(events, reminders, {
        start: sunday - 600_000,
        end: sunday + 7 * DAY - 600_000,
      }).map((row) => row.due_at),
    ).toEqual([sunday - 600_000]);
    expect(expandEvents(events, { start: sunday - DAY, end: sunday + 8 * DAY })).toHaveLength(2);
  });
  it("预期影响行数不匹配时整个批次回滚", async () => {
    const { db, root, data } = await setup();
    await expect(
      db.batch([
        { query: "UPDATE events SET title = ? WHERE id = ?", values: ["不应保存", root.id] },
        {
          query: "UPDATE events SET title = ? WHERE id = ?",
          values: ["无", "missing"],
          expectedRows: 1,
        },
      ]),
    ).rejects.toThrow("发生变化");
    expect((await data.events.get(root.id))?.title).toBe(root.title);
  });
});
