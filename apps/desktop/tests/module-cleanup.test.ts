import { afterEach, expect, it } from "vitest";
import { fixture, type MemoryDatabase } from "./memory-database";
import { FINANCE_WORKBENCH } from "../src/core/finance/finance-target";

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

it("金融卸载原子清除私有状态并保留用户设置和共享提醒墓碑", async () => {
  const { db, data, clock } = await fixture();
  database = db;
  const threshold = await data.financeThresholds.create({
    indicator_id: "top5",
    series_key: "top5",
    enabled: true,
    direction: "above",
    level: 45,
    hysteresis: 1,
    label: "旧版提醒阈值",
  });
  await data.financeAlertStates.commit(
    [
      {
        next: {
          threshold_id: threshold.id,
          threshold_version: threshold.updated_at,
          breached: true,
          evaluated_through: 20261123,
          last_crossed_date: 20261123,
          last_reminder_id: null,
        },
        previous: undefined,
      },
    ],
    [],
  );
  const reminder = await data.reminders.create({
    title: "金融阈值越线",
    notes: "待清空",
    source_workbench: FINANCE_WORKBENCH,
  });
  await data.settings.setValue("finance.overlay_hs300", false);
  await data.settings.setValue("ai.global_shortcut", "Ctrl+Alt+Space");
  await data.settings.setValue("core.general.hidden", true);
  db.failAt = 2;
  await expect(data.moduleCleanup.purgeSharedData(FINANCE_WORKBENCH)).rejects.toThrow(
    "模拟事务失败",
  );
  expect(await data.financeThresholds.get(threshold.id)).not.toBeNull();
  expect(await data.financeAlertStates.list()).toHaveLength(1);
  expect(await data.settings.getValue("finance.overlay_hs300")).toBe(false);

  db.failAt = null;
  await data.moduleCleanup.purgeSharedData(FINANCE_WORKBENCH);
  await data.moduleCleanup.purgeSharedData(FINANCE_WORKBENCH);
  for (const table of ["finance_thresholds", "finance_alert_states", "workbench_kv"]) {
    expect(await db.select(`SELECT * FROM ${table}`)).toEqual([]);
  }
  expect(await db.select("SELECT * FROM settings WHERE key GLOB 'finance.*'")).toEqual([]);
  expect(await data.settings.getValue("ai.global_shortcut")).toBe("Ctrl+Alt+Space");
  expect(await data.settings.getValue("core.general.hidden")).toBe(true);
  expect(
    await db.select(
      "SELECT id,title,notes,source_workbench,purged_at FROM reminders WHERE id = ?",
      [reminder.id],
    ),
  ).toEqual([
    { id: reminder.id, title: "", notes: "", source_workbench: null, purged_at: clock.now },
  ]);
});
