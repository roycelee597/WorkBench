import { afterEach, expect, it } from "vitest";
import { fixture, type MemoryDatabase } from "./memory-database";

let database: MemoryDatabase | undefined;
afterEach(() => {
  database?.close();
  database = undefined;
});

it("卸载清空模块共享内容和关联实例，保留同步墓碑及他人内容", async () => {
  const { db, data, clock } = await fixture();
  database = db;
  const moduleId = "com.example.timer";
  const ownedMemo = await data.memos.createForModule(moduleId, {
    title: "模块备忘",
    content: "示例",
  });
  const keepMemo = await data.memos.create({ title: "自己的备忘" });
  const event = await data.events.create({
    title: "模块日程",
    start_at: clock.now,
    end_at: clock.now + 60_000,
    remind_before_minutes: 10,
    source_workbench: moduleId,
  });
  const reminder = (await data.reminders.list()).find((row) => row.event_id === event.id)!;
  const occurrence = await data.occurrences.ensure(reminder, reminder.due_at);
  expect(await data.memos.updateForModule(moduleId, keepMemo.id, { title: "不能写入" })).toBeNull();
  expect(
    (await data.memos.updateForModule(moduleId, ownedMemo.id, { title: "可以写入" }))?.title,
  ).toBe("可以写入");

  db.failAt = 2;
  await expect(data.moduleCleanup.purgeSharedData(moduleId)).rejects.toThrow("模拟事务失败");
  expect(await data.occurrences.get(occurrence.id)).not.toBeNull();
  expect(await data.memos.get(ownedMemo.id)).not.toBeNull();

  db.failAt = null;
  await data.moduleCleanup.purgeSharedData(moduleId);
  await data.moduleCleanup.purgeSharedData(moduleId);
  expect(await data.memos.get(ownedMemo.id)).toBeNull();
  expect(await data.events.get(event.id)).toBeNull();
  expect(await data.reminders.get(reminder.id)).toBeNull();
  expect(await data.occurrences.get(occurrence.id)).toBeNull();
  expect((await data.memos.get(keepMemo.id))?.title).toBe("自己的备忘");
  for (const [table, id] of [
    ["memos", ownedMemo.id],
    ["events", event.id],
    ["reminders", reminder.id],
    ["reminder_occurrences", occurrence.id],
  ] as const) {
    const [tombstone] = await db.select(
      `SELECT id, title, deleted_at, purged_at FROM ${table} WHERE id = ?`,
      [id],
    );
    expect(tombstone).toEqual({ id, title: "", deleted_at: clock.now, purged_at: clock.now });
  }
});

it("综合工作台不可作为模块清理", async () => {
  const { db, data } = await fixture();
  database = db;
  await expect(data.moduleCleanup.purgeSharedData("com.royce.workbench.general")).rejects.toThrow(
    "不可卸载",
  );
});
