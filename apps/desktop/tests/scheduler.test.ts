import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createDataLayer } from "../src/core/repositories";
import {
  ReminderScheduler,
  type SchedulerClock,
  type NotificationMessage,
} from "../src/core/scheduler/scheduler";
import {
  completeReminder,
  loadReminderItems,
  snoozeReminder,
} from "../src/core/scheduler/reminder-service";
import { nextReminderDue } from "../src/core/scheduler/reminder-time";
import { MemoryDatabase } from "./memory-database";

const DAY = 86_400_000;
const databases: MemoryDatabase[] = [];
const schedulers: ReminderScheduler[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-05T01:00:00Z"));
});
afterEach(() => {
  schedulers.splice(0).forEach((scheduler) => scheduler.stop());
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
async function setup() {
  const db = new MemoryDatabase();
  databases.push(db);
  const data = await createDataLayer(db, { now: () => Date.now() });
  const messages: NotificationMessage[] = [];
  const show = vi.fn(async (message: NotificationMessage) => {
    messages.push(message);
  });
  const error = vi.fn();
  const clock: SchedulerClock = {
    now: () => Date.now(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const engine = new ReminderScheduler(data, { show }, clock, error);
  schedulers.push(engine);
  return { db, data, engine, messages, show, error, clock };
}
describe("提醒调度", () => {
  it("精确到点通知，30 秒轮询与并发唤醒不会重复，停止后移除定时器", async () => {
    const { data, engine, messages } = await setup();
    const due = Date.now() + 5000;
    const reminder = await data.reminders.create({
      title: "喝水",
      notes: "第一行\n第二行",
      due_at: due,
    });
    await engine.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await engine.wake();
    expect(messages).toEqual([
      expect.objectContaining({ kind: "reminder", title: "喝水", body: "第一行" }),
    ]);
    expect((await data.reminders.get(reminder.id))?.notified_at).toBe(due);
    await Promise.all([engine.wake(), engine.wake()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages).toHaveLength(1);
    engine.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("数据变动立即重排精确定时，完成无时间待办不发通知", async () => {
    const { data, engine, messages } = await setup();
    await engine.start();
    const todo = await data.reminders.create({ title: "普通待办" });
    await completeReminder(data, { reminderId: todo.id }, Date.now());
    await data.reminders.create({ title: "新增定时", due_at: Date.now() + 1000 });
    await engine.wake();
    await vi.advanceTimersByTimeAsync(1000);
    await engine.wake();
    expect(messages.map((message) => message.title)).toEqual(["新增定时"]);
    expect(
      (await loadReminderItems(data)).find((row) => row.reminder.id === todo.id)?.completed_at,
    ).not.toBeNull();
  });
  it("同轮普通通知失败不吞掉尚未发出的启动错过汇总", async () => {
    const { data, show, clock, error, messages } = await setup();
    await data.reminders.create({ title: "错过", due_at: Date.now() - 5000 });
    await data.reminders.create({ title: "恰好到点", due_at: Date.now() + 1000 });
    vi.setSystemTime(Date.now() + 1000);
    show.mockRejectedValueOnce(new Error("暂时无法显示窗口"));
    const engine = new ReminderScheduler(data, { show }, clock, error);
    schedulers.push(engine);
    await engine.start();
    expect(error).toHaveBeenCalledOnce();
    expect((await data.occurrences.list()).every((row) => row.notified_at === null)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await engine.wake();
    expect(messages.map((message) => message.kind)).toEqual(["reminder", "missed"]);
  });
  it("启动将错过提醒合并一次，排除已完成、已通知和普通待办，重启不重复", async () => {
    const { data, engine, messages, clock } = await setup();
    const first = Date.now();
    await data.reminders.create({ title: "错过一", due_at: first - 5000 });
    await data.reminders.create({ title: "错过二", due_at: first - 1000 });
    await data.reminders.create({
      title: "已通知",
      due_at: first - 1000,
      notified_at: first - 500,
    });
    await data.reminders.create({
      title: "已完成",
      due_at: first - 1000,
      completed_at: first - 500,
    });
    await data.reminders.create({ title: "普通待办" });
    vi.setSystemTime(first + 1000);
    const restarted = new ReminderScheduler(
      data,
      {
        show: async (message) => {
          messages.push(message);
        },
      },
      clock,
    );
    schedulers.push(restarted);
    await restarted.start();
    expect(messages).toEqual([
      expect.objectContaining({ kind: "missed", title: "你有 2 条错过的提醒" }),
    ]);
    expect(messages[0]?.occurrenceIds).toHaveLength(2);
    restarted.stop();
    await engine.start();
    expect(messages).toHaveLength(1);
  });
  it("重复完成按固定起点计算 COUNT，保留已完成历史，最后一次完成后不再产生下一次", async () => {
    const { data } = await setup();
    const due = Date.now() + 1000;
    const reminder = await data.reminders.create({
      title: "三次",
      due_at: due,
      timezone: "UTC",
      rrule: "FREQ=DAILY;COUNT=3",
    });
    for (let count = 0; count < 3; count++) {
      await completeReminder(data, { reminderId: reminder.id }, Date.now());
      const current = await data.reminders.get(reminder.id);
      expect(current?.recurrence_start_at).toBe(due);
      expect(current?.due_at).toBe(due + Math.min(count + 1, 2) * DAY);
      expect(current?.completed_at !== null).toBe(count === 2);
    }
    expect((await loadReminderItems(data)).filter((row) => row.completed_at !== null)).toHaveLength(
      3,
    );
  });
  it("重复触发后推进下一次；旧通知的完成和贪睡不会再次推进未来", async () => {
    const { data, engine, messages } = await setup();
    const due = Date.now() + 1000;
    const reminder = await data.reminders.create({
      title: "每天",
      due_at: due,
      timezone: "UTC",
      rrule: "FREQ=DAILY;COUNT=3",
    });
    await engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    await engine.wake();
    const occurrenceId = messages[0]!.occurrenceIds[0]!;
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + DAY);
    await snoozeReminder(data, { reminderId: reminder.id, occurrenceId });
    await engine.wake();
    expect((await data.occurrences.get(occurrenceId))?.snooze_until).toBe(due + 600_000);
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + DAY);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await engine.wake();
    expect(messages).toHaveLength(2);
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + DAY);
    await completeReminder(data, { reminderId: reminder.id, occurrenceId }, Date.now());
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + DAY);
    expect((await data.occurrences.get(occurrenceId))?.completed_at).toBe(Date.now());
  });
  it("单次提醒贪睡固定 10 分钟，完成会取消贪睡", async () => {
    const { data, engine, messages } = await setup();
    const reminder = await data.reminders.create({ title: "单次", due_at: Date.now() + 1000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    await engine.wake();
    await snoozeReminder(data, { reminderId: reminder.id });
    expect((await data.reminders.get(reminder.id))?.snooze_until).toBe(Date.now() + 600_000);
    await completeReminder(data, { reminderId: reminder.id }, Date.now());
    await engine.wake();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(messages).toHaveLength(1);
  });
  it("睡眠或时钟跳跃后补查一次并跳到未来，COUNT 不会从推进后的 due_at 重算", async () => {
    const { data, engine, messages } = await setup();
    const due = Date.now() + 1000;
    const reminder = await data.reminders.create({
      title: "睡眠恢复",
      due_at: due,
      timezone: "UTC",
      rrule: "FREQ=DAILY;COUNT=4",
    });
    await engine.start();
    vi.setSystemTime(due + 2 * DAY + 1000);
    await engine.wake();
    expect(messages).toHaveLength(1);
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + 3 * DAY);
    await completeReminder(data, { reminderId: reminder.id }, Date.now());
    expect((await data.reminders.get(reminder.id))?.completed_at).not.toBeNull();
    expect(nextReminderDue((await data.reminders.get(reminder.id))!, due + 3 * DAY, [])).toBeNull();
  });
  it("通知端口失败后释放通知标记，30 秒后重试同一实例，不二次推进系列", async () => {
    const { data, engine, show, error, messages } = await setup();
    const due = Date.now() + 1000;
    const reminder = await data.reminders.create({
      title: "重试",
      due_at: due,
      timezone: "UTC",
      rrule: "FREQ=DAILY;COUNT=3",
    });
    show.mockRejectedValueOnce(new Error("系统通知暂不可用"));
    await engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    await engine.wake();
    expect(error).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
    expect((await data.occurrences.list())[0]?.notified_at).toBeNull();
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + DAY);
    await vi.advanceTimersByTimeAsync(30_000);
    await engine.wake();
    expect(messages).toHaveLength(1);
    expect((await data.reminders.get(reminder.id))?.due_at).toBe(due + DAY);
  });
  it("领取实例与推进游标在同一事务，失败不会提前标记或发出通知", async () => {
    const { db, data } = await setup();
    const due = Date.now();
    const parent = await data.reminders.create({
      title: "事务",
      due_at: due,
      rrule: "FREQ=DAILY;COUNT=2",
    });
    const row = await data.occurrences.ensure(parent, due);
    db.failAt = 1;
    await expect(data.occurrences.claim(row, parent, due + DAY)).rejects.toThrow("模拟事务失败");
    db.failAt = null;
    expect((await data.occurrences.get(row.id))?.notified_at).toBeNull();
    expect((await data.reminders.get(parent.id))?.due_at).toBe(due);
    const results = await Promise.all([
      data.occurrences.claim(row, parent, due + DAY),
      data.occurrences.claim(row, parent, due + DAY),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("日程提醒跨午夜并遵守 EXDATE；改标题不把已推进的提醒退回第一天", async () => {
    const { data, engine, messages } = await setup();
    const start = Date.parse("2026-11-08T00:05Z");
    vi.setSystemTime(start - 11 * 60_000);
    const event = await data.events.create({
      title: "周日凌晨",
      start_at: start,
      end_at: start + 3_600_000,
      timezone: "UTC",
      rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=3",
      remind_before_minutes: 10,
      exdates: [start + 7 * DAY],
    });
    await engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await engine.wake();
    expect(messages).toHaveLength(1);
    const parent = (await data.reminders.list())[0]!;
    expect(parent.due_at).toBe(start + 14 * DAY - 600_000);
    await data.events.update(event.id, { title: "改标题" });
    await engine.wake();
    const saved = (await data.reminders.get(parent.id))!;
    expect(saved.due_at).toBe(parent.due_at);
    expect(saved.schedule_version).toBe(parent.schedule_version);
    expect(saved.title).toBe("改标题");
    await expect(data.reminders.update(parent.id, { due_at: 0 })).rejects.toThrow("日程生成");
    await data.reminders.update(parent.id, { priority: 3 });
  });
  it("日程变动后的旧快照不能领取，日程删除/恢复/清空联动实例状态", async () => {
    const { data, db } = await setup();
    const due = Date.now();
    const event = await data.events.create({
      title: "联动",
      start_at: due + 600_000,
      end_at: due + 3_600_000,
      remind_before_minutes: 10,
      timezone: "UTC",
    });
    const parent = (await data.reminders.list())[0]!;
    const row = await data.occurrences.ensure(parent, due);
    await data.events.update(event.id, { title: "已更改" });
    expect(await data.occurrences.claim(row, parent, null, [event])).toBe(false);
    await data.events.softDelete(event.id);
    expect(await data.occurrences.list()).toEqual([]);
    await data.events.restore(event.id);
    expect(await data.occurrences.list()).toHaveLength(1);
    await data.events.softDelete(event.id);
    await data.events.purgeContent(event.id);
    expect(
      (
        await db.select(
          "SELECT id,title,deleted_at,purged_at FROM reminder_occurrences WHERE id = ?",
          [row.id],
        )
      )[0],
    ).toMatchObject({
      id: row.id,
      title: "",
      deleted_at: expect.any(Number),
      purged_at: expect.any(Number),
    });
  });
  it("重新安排时间会使旧通知失效，保留已完成历史；30 天清理也清空实例内容", async () => {
    const { data, db } = await setup();
    const now = Date.now();
    const reminder = await data.reminders.create({
      title: "历史",
      due_at: now + 1000,
      rrule: "FREQ=DAILY;COUNT=3",
    });
    await completeReminder(data, { reminderId: reminder.id }, now);
    const completed = (await data.occurrences.list())[0]!;
    await data.reminders.update(reminder.id, { due_at: now + 5000 });
    await expect(
      snoozeReminder(data, { reminderId: reminder.id, occurrenceId: completed.id }),
    ).rejects.toThrow("时间已改变");
    expect((await loadReminderItems(data)).filter((row) => row.completed_at !== null)).toHaveLength(
      1,
    );
    await data.reminders.softDelete(reminder.id);
    vi.setSystemTime(now + 30 * DAY);
    await data.trash.purgeExpired();
    expect((await data.occurrences.listDeleted())[0]?.purged_at).toBeNull();
    vi.setSystemTime(now + 30 * DAY + 1);
    await data.trash.purgeExpired();
    expect(await data.occurrences.listDeleted()).toEqual([]);
    expect(
      (
        await db.select(
          "SELECT title,deleted_at,purged_at FROM reminder_occurrences WHERE id = ?",
          [completed.id],
        )
      )[0],
    ).toMatchObject({ title: "", deleted_at: now, purged_at: now + 30 * DAY + 1 });
  });
  it("首次自启提示通过条件写入领取一次，通知状态监听失败不回滚已保存数据", async () => {
    const { data } = await setup();
    expect(
      await Promise.all([
        data.settings.claimAutostartPrompt(),
        data.settings.claimAutostartPrompt(),
      ]),
    ).toEqual([true, false]);
    expect(await data.settings.getValue("autostart_prompted")).toBe(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const off = data.changes.subscribe(() => {
      throw new Error("监听失败");
    });
    const reminder = await data.reminders.create({ title: "应成功" });
    expect(await data.reminders.get(reminder.id)).not.toBeNull();
    off();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
describe("提醒迁移", () => {
  it("从 0001 升级保留记录及元数据，补齐原重复起点和时区", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const directory = new NodeURL("../src-tauri/migrations/", import.meta.url);
      db.exec(readFileSync(new NodeURL("0001_init.sql", directory), "utf8"));
      db.prepare(
        "INSERT INTO reminders(id,created_at,updated_at,device_id,title,due_at,rrule) VALUES(?,?,?,?,?,?,?)",
      ).run("legacy", 1, 2, "device", "旧提醒", 1234, "FREQ=DAILY;COUNT=3");
      db.exec(readFileSync(new NodeURL("0002_reminder_scheduler.sql", directory), "utf8"));
      expect(
        db
          .prepare(
            "SELECT id,title,created_at,updated_at,due_at,recurrence_start_at,timezone,schedule_version FROM reminders",
          )
          .get(),
      ).toMatchObject({
        id: "legacy",
        title: "旧提醒",
        created_at: 1,
        updated_at: 2,
        due_at: 1234,
        recurrence_start_at: 1234,
        timezone: "Asia/Shanghai",
        schedule_version: "legacy",
      });
    } finally {
      db.close();
    }
  });
});
