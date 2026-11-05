import { describe, expect, it } from "vitest";
import { filterReminders, reminderFields, reminderForm } from "../src/reminder-model";
import { loadReminderItems } from "../../../apps/desktop/src/core/scheduler/reminder-service";
import { fixture } from "../../../apps/desktop/tests/memory-database";

describe("提醒分组与表单", () => {
  it("今天含逾期且不含明日，计划中排除无时间待办，完成按时间倒序", async () => {
    const { db, data } = await fixture();
    try {
      const now = new Date(2026, 10, 5, 12).getTime();
      const tomorrow = new Date(2026, 10, 6).getTime();
      const overdue = await data.reminders.create({ title: "逾期", due_at: now - 86_400_000 });
      const low = await data.reminders.create({ title: "低", due_at: now, priority: 1 });
      const high = await data.reminders.create({ title: "高", due_at: now, priority: 3 });
      const future = await data.reminders.create({ title: "明日", due_at: tomorrow });
      const todo = await data.reminders.create({ title: "待办" });
      await data.reminders.create({ title: "先完成", completed_at: now - 1 });
      await data.reminders.create({ title: "后完成", completed_at: now });
      const items = await loadReminderItems(data);
      const ids = (group: Parameters<typeof filterReminders>[1]) =>
        filterReminders(items, group, now).map((item) => item.reminder.id);
      expect(ids("today")).toEqual([overdue.id, high.id, low.id]);
      expect(ids("planned")).toEqual([overdue.id, high.id, low.id, future.id]);
      expect(ids("all")).toEqual([overdue.id, high.id, low.id, future.id, todo.id]);
      expect(filterReminders(items, "completed", now).map((item) => item.title)).toEqual([
        "后完成",
        "先完成",
      ]);
      expect(items).toHaveLength(7);
    } finally {
      db.close();
    }
  });
  it("只改标题保留原时间的秒与完整 RRULE，取消时间同时取消重复", async () => {
    const { db, data } = await fixture();
    try {
      const original = await data.reminders.create({
        title: "原题",
        due_at: Date.parse("2026-11-05T09:00:37Z"),
        timezone: "UTC",
        rrule: "FREQ=WEEKLY;BYDAY=TH;COUNT=5",
      });
      const initial = reminderForm(original);
      const fields = reminderFields({ ...initial, title: "新题" }, initial, original);
      expect(fields).toMatchObject({
        title: "新题",
        due_at: original.due_at,
        rrule: original.rrule,
      });
      expect(reminderFields({ ...initial, timed: false }, initial, original)).toMatchObject({
        due_at: null,
        rrule: null,
      });
      expect(() => reminderFields({ ...initial, title: " " })).toThrow("标题");
      expect(() => reminderFields({ ...initial, priority: 4 })).toThrow("优先级");
    } finally {
      db.close();
    }
  });
});
