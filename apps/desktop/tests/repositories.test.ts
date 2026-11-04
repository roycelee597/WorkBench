import { afterEach, describe, expect, it } from "vitest";
import { version } from "uuid";
import { createDataLayer } from "../src/core/repositories";
import { fixture, MemoryDatabase } from "./memory-database";

const databases: MemoryDatabase[] = [];
async function setup() {
  const value = await fixture();
  databases.push(value.db);
  return value;
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});

describe("仓库、元数据和软删除", () => {
  it("无效数组、JSON 与元数据修改不会写入数据库", async () => {
    const { data } = await setup();
    const memo = await data.memos.create({ title: "原值" });
    await expect(
      data.memos.update(memo.id, { tags: [1] } as unknown as { tags: string[] }),
    ).rejects.toThrow();
    await expect(
      data.memos.update(memo.id, { id: "篡改" } as unknown as { title: string }),
    ).rejects.toThrow();
    await expect(data.settings.setValue("bad", Number.NaN)).rejects.toThrow();
    expect(await data.settings.getValue("bad")).toBeUndefined();
    expect(await data.memos.get(memo.id)).toEqual(memo);
  });
  it("恢复例外时遵守唯一性，不影响此前单独删除的例外", async () => {
    const { data, clock } = await setup();
    const root = await data.events.create({
      title: "系列",
      start_at: clock.now,
      end_at: clock.now,
      rrule: "FREQ=DAILY",
    });
    const input = {
      title: "旧例外",
      start_at: clock.now,
      end_at: clock.now,
      recurrence_id: root.id,
      original_start_at: clock.now,
    };
    const old = await data.events.create(input);
    await data.events.softDelete(old.id);
    const replacement = await data.events.create({ ...input, title: "新例外" });
    await expect(data.events.restore(old.id)).rejects.toThrow();
    expect(await data.events.get(replacement.id)).not.toBeNull();
    await data.events.softDelete(root.id);
    await data.events.restore(root.id);
    expect(await data.events.get(old.id)).toBeNull();
    expect(await data.events.get(replacement.id)).not.toBeNull();
  });
  it("迁移包含所需索引，设备标识跨初始化保持不变", async () => {
    const { db, data } = await setup();
    expect(version(data.deviceId)).toBe(7);
    const again = await createDataLayer(db);
    expect(again.deviceId).toBe(data.deviceId);
    const indexes = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    );
    expect(indexes.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "idx_events_range",
        "idx_reminders_event",
        "idx_reminders_due",
        "idx_events_exception",
      ]),
    );
  });
  it("便笺 CRUD 使用绑定参数、UUID v7、毫秒时间和设备标识", async () => {
    const { data, db, clock } = await setup();
    const memo = await data.memos.create({
      title: "引号 ' ; DROP TABLE memos; --",
      content: "正文",
      tags: ["中文", "a'b"],
    });
    expect(version(memo.id)).toBe(7);
    expect(memo).toMatchObject({
      created_at: clock.now,
      updated_at: clock.now,
      device_id: data.deviceId,
      deleted_at: null,
      pinned: false,
    });
    clock.now += 1234;
    const updated = await data.memos.update(memo.id, { pinned: true, content: "修改" });
    expect(updated).toMatchObject({
      created_at: memo.created_at,
      updated_at: clock.now,
      content: "修改",
      tags: memo.tags,
    });
    const other = await data.memos.create({ title: "普通" });
    expect((await data.memos.list()).map((row) => row.id)).toEqual([memo.id, other.id]);
    expect(await data.memos.softDelete(memo.id)).toBe(true);
    expect(await data.memos.get(memo.id)).toBeNull();
    expect(await data.memos.listDeleted()).toEqual([
      expect.objectContaining({ id: memo.id, deleted_at: clock.now }),
    ]);
    await expect(data.memos.update(memo.id, { title: "不应成功" })).rejects.toThrow();
    expect(await data.memos.restore(memo.id)).toBe(true);
    await expect(data.memos.purgeContent(memo.id)).rejects.toThrow();
    await data.memos.softDelete(memo.id);
    expect(await data.memos.purgeContent(memo.id)).toBe(true);
    expect(await data.memos.purgeContent(memo.id)).toBe(false);
    expect(await data.memos.listDeleted()).toEqual([]);
    await expect(data.memos.restore(memo.id)).rejects.toThrow("清空");
    const rows = await db.select<{
      title: string;
      content: string;
      tags: string;
      deleted_at: number;
    }>("SELECT * FROM memos WHERE id = ?", [memo.id]);
    expect(rows[0]).toMatchObject({ title: "", content: "", tags: "[]", deleted_at: clock.now });
  });
  it("设置保存 JSON，更新保留 id 和 created_at，支持回收与墓碑", async () => {
    const { data, clock } = await setup();
    await data.settings.setValue("preferences", { nested: [true, 2, null, "中文"] });
    const first = (await data.settings.list()).find((row) => row.key === "preferences")!;
    clock.now++;
    await data.settings.setValue("preferences", false);
    expect(await data.settings.get(first.id)).toMatchObject({
      id: first.id,
      created_at: first.created_at,
      updated_at: clock.now,
      value: false,
    });
    await data.settings.softDelete(first.id);
    expect(await data.settings.getValue("preferences")).toBeUndefined();
    await data.settings.restore(first.id);
    expect(await data.settings.getValue("preferences")).toBe(false);
    await data.settings.softDelete(first.id);
    await data.settings.purgeContent(first.id);
    await expect(data.settings.restore(first.id)).rejects.toThrow();
    const device = (await data.settings.list()).find((row) => row.key === "device_id")!;
    await expect(data.settings.setValue("device_id", "x")).rejects.toThrow();
    await expect(data.settings.softDelete(device.id)).rejects.toThrow();
    await expect(data.settings.purgeContent(device.id)).rejects.toThrow();
  });
  it("日程字段往返、例外唯一性和提醒字段校验", async () => {
    const { data, clock } = await setup();
    const series = await data.events.create({
      title: "每周",
      start_at: clock.now,
      end_at: clock.now + 1000,
      rrule: "FREQ=WEEKLY;COUNT=4",
      exdates: [clock.now],
      remind_before_minutes: 15,
    });
    expect(await data.events.update(series.id, { notes: "备注", color: "#fff" })).toMatchObject({
      notes: "备注",
      color: "#fff",
      exdates: [clock.now],
    });
    const input = {
      title: "例外",
      start_at: clock.now,
      end_at: clock.now,
      recurrence_id: series.id,
      original_start_at: clock.now,
    };
    await data.events.create(input);
    await expect(data.events.create(input)).rejects.toThrow();
    await expect(data.events.create({ ...input, recurrence_id: "missing" })).rejects.toThrow();
    await expect(data.events.create({ title: "错", start_at: 2, end_at: 1 })).rejects.toThrow();
    await expect(
      data.events.create({ title: "错", start_at: 1, end_at: 2, rrule: "FREQ=DAILY;COUNT=0" }),
    ).rejects.toThrow();
    const reminder = await data.reminders.create({
      title: "提醒",
      source: "event",
      event_id: series.id,
      due_at: clock.now,
      rrule: "FREQ=DAILY",
      priority: 2,
    });
    expect(
      await data.reminders.update(reminder.id, {
        completed_at: clock.now,
        notified_at: clock.now,
        snooze_until: clock.now + 5000,
      }),
    ).toMatchObject({
      completed_at: clock.now,
      notified_at: clock.now,
      snooze_until: clock.now + 5000,
    });
    await expect(data.reminders.create({ title: "错", priority: 4 })).rejects.toThrow();
    await expect(data.reminders.create({ title: "错", due_at: 0.5 })).rejects.toThrow();
    await expect(data.reminders.create({ title: "错", source: "event" })).rejects.toThrow();
    await data.reminders.softDelete(reminder.id);
    expect(await data.reminders.list()).toEqual([]);
    await data.reminders.restore(reminder.id);
    await data.reminders.softDelete(reminder.id);
    await data.reminders.purgeContent(reminder.id);
    expect(await data.reminders.listDeleted()).toEqual([]);
    await expect(data.reminders.restore(reminder.id)).rejects.toThrow();
  });
  it("删除、恢复日程联动例外及提醒，不恢复同毫秒独立删除的记录", async () => {
    const { data, clock, db } = await setup();
    const root = await data.events.create({
      title: "系列",
      start_at: clock.now,
      end_at: clock.now,
      rrule: "FREQ=DAILY",
    });
    const exception = await data.events.create({
      title: "例外",
      start_at: clock.now + 1,
      end_at: clock.now + 1,
      recurrence_id: root.id,
      original_start_at: clock.now,
    });
    const linked = await data.reminders.create({
      title: "联动",
      event_id: exception.id,
      source: "event",
    });
    const independent = await data.reminders.create({
      title: "已独立删除",
      event_id: root.id,
      source: "event",
    });
    await data.reminders.softDelete(independent.id);
    db.failAt = 1;
    await expect(data.events.softDelete(root.id)).rejects.toThrow("模拟");
    expect(await data.events.get(root.id)).not.toBeNull();
    db.failAt = null;
    await data.events.softDelete(root.id);
    expect(await data.events.list()).toEqual([]);
    expect(await data.reminders.get(linked.id)).toBeNull();
    await expect(data.reminders.restore(linked.id)).rejects.toThrow("先恢复");
    await expect(data.events.restore(exception.id)).rejects.toThrow("先恢复");
    await data.events.restore(root.id);
    expect(await data.events.get(exception.id)).not.toBeNull();
    expect(await data.reminders.get(linked.id)).not.toBeNull();
    expect(await data.reminders.get(independent.id)).toBeNull();
    await data.events.softDelete(root.id);
    await data.events.purgeContent(root.id);
    expect(await data.events.listDeleted()).toEqual([]);
    expect(await data.reminders.listDeleted()).toEqual([]);
    await expect(data.events.restore(root.id)).rejects.toThrow("清空");
  });
});
