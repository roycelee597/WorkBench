import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  startTrashMaintenance,
  TRASH_RETENTION_MS,
} from "../src/core/repositories/trash-cleaner";
import { fixture, MemoryDatabase } from "./memory-database";

const databases: MemoryDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
describe("回收站清理", () => {
  it("严格早于 30 天才清空，保留墓碑元数据且不会反复清空", async () => {
    const { db, clock, data } = await fixture();
    databases.push(db);
    const old = await data.memos.create({
      title: "过期",
      content: "秘密",
      pinned: true,
      tags: ["标签"],
    });
    const event = await data.events.create({
      title: "过期日程",
      notes: "备注",
      start_at: clock.now,
      end_at: clock.now + 1000,
      rrule: "FREQ=DAILY",
      exdates: [clock.now],
      color: "red",
    });
    const reminder = await data.reminders.create({
      title: "过期提醒",
      notes: "备注",
      due_at: clock.now,
      event_id: event.id,
      source: "event",
    });
    await data.memos.softDelete(old.id);
    await data.events.softDelete(event.id);
    const before = (await data.memos.listDeleted())[0]!;
    clock.now++;
    const boundary = await data.memos.create({ title: "正好30天" });
    await data.memos.softDelete(boundary.id);
    clock.now++;
    const young = await data.memos.create({ title: "未到期" });
    await data.memos.softDelete(young.id);
    const active = await data.memos.create({ title: "活跃" });
    clock.now = old.created_at + TRASH_RETENTION_MS + 1;
    expect(await data.trash.purgeExpired()).toEqual({ memos: 1, events: 1, reminders: 1 });
    expect((await data.memos.listDeleted()).map((row) => row.id)).toEqual(
      expect.arrayContaining([boundary.id, young.id]),
    );
    expect(await data.memos.get(active.id)).not.toBeNull();
    const rows = await db.select<Record<string, string | number | null>>(
      "SELECT * FROM memos WHERE id = ?",
      [old.id],
    );
    expect(rows[0]).toMatchObject({
      id: old.id,
      created_at: old.created_at,
      deleted_at: before.deleted_at,
      deletion_group_id: before.deletion_group_id,
      purged_at: clock.now,
      title: "",
      content: "",
      tags: "[]",
      pinned: 0,
    });
    expect((await db.select("SELECT * FROM events WHERE id = ?", [event.id]))[0]).toMatchObject({
      title: "",
      notes: "",
      start_at: 0,
      end_at: 0,
      rrule: null,
      exdates: "[]",
      color: null,
    });
    expect(
      (await db.select("SELECT * FROM reminders WHERE id = ?", [reminder.id]))[0],
    ).toMatchObject({ title: "", notes: "", due_at: null, event_id: null });
    expect(await data.settings.getValue("last_trash_purge_at")).toBe(clock.now);
    expect(await data.trash.purgeExpired()).toEqual({ memos: 0, events: 0, reminders: 0 });
    expect((await db.select("SELECT purged_at FROM memos WHERE id = ?", [old.id]))[0]).toEqual({
      purged_at: clock.now,
    });
  });
  it("失败回滚全部清理和成功时间", async () => {
    const { db, clock, data } = await fixture();
    databases.push(db);
    const memo = await data.memos.create({ title: "待清理" });
    await data.memos.softDelete(memo.id);
    await data.settings.setValue("last_trash_purge_at", 123);
    clock.now += TRASH_RETENTION_MS + 1;
    db.failAt = 3;
    await expect(data.trash.purgeExpired()).rejects.toThrow("模拟");
    expect(await data.settings.getValue("last_trash_purge_at")).toBe(123);
    expect(await data.memos.listDeleted()).toEqual([
      expect.objectContaining({ title: "待清理", purged_at: null }),
    ]);
  });
  it("启动执行一次、每天执行并可停止；失败不会留下定时器", async () => {
    vi.useFakeTimers();
    const purgeExpired = vi.fn().mockResolvedValue({ memos: 0, events: 0, reminders: 0 });
    const stop = await startTrashMaintenance({ purgeExpired });
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    await expect(
      startTrashMaintenance({ purgeExpired: vi.fn().mockRejectedValue(new Error("失败")) }),
    ).rejects.toThrow("失败");
    expect(vi.getTimerCount()).toBe(0);
  });
});
