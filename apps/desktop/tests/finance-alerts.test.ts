import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceAlerts } from "../src/core/finance/finance-alerts";
import type { FinanceDone } from "../src/core/finance/engine-events";
import type { DateRange, FinancePoint, IndicatorMeta } from "../src/core/finance/finance-reader";
import { FINANCE_WORKBENCH } from "../src/core/finance/finance-target";
import { evaluateThreshold } from "../src/core/finance/threshold-evaluator";
import { completeReminder, loadReminderItems } from "../src/core/scheduler/reminder-service";
import { ReminderScheduler } from "../src/core/scheduler/scheduler";
import { createInAppNotificationPort } from "../src/core/scheduler/notification-port";
import type { ThresholdInput } from "../src/core/repositories/finance-thresholds";
import { dispatchNotification } from "../src/shell/notification-action";
import { preferencesForTarget } from "../../../workbenches/finance/src/preferences";
import { fixture } from "./memory-database";

const key = "top5_turnover_share";
const main: ThresholdInput = {
  indicator_id: key,
  series_key: key,
  direction: "above",
  level: 45,
  hysteresis: 1,
  enabled: true,
  label: "交易拥挤",
};
const indices = ["000300.SH", "399006.SZ", "000001.SH"];
const valuations = indices.map((index) => ({
  key: `valuation.${index}.pe_ttm.pct_10y`,
  index,
  label: index,
  metric: "pe_ttm" as const,
  window: "pct_10y" as const,
}));
const meta: IndicatorMeta[] = [
  {
    id: key,
    name: "前 5% 成交额占比",
    group: "交易拥挤",
    order: 1,
    unit: "percent",
    series: [{ key, label: "占比" }],
    default_thresholds: [
      {
        default_key: "top5",
        series_key: key,
        direction: "above",
        level: 45,
        hysteresis: 1,
        label: "交易拥挤",
      },
    ],
  },
  {
    id: "new_high",
    name: "新高占比",
    group: "宽度",
    order: 2,
    series: [{ key: "new_high", label: "占比" }],
    default_thresholds: [
      {
        default_key: "high",
        series_key: "new_high",
        direction: "above",
        level: 20,
        hysteresis: 1,
        label: "过热",
      },
      {
        default_key: "low",
        series_key: "new_high",
        direction: "below",
        level: 3,
        hysteresis: 0.5,
        label: "很弱",
      },
    ],
  },
  {
    id: "index_valuation",
    name: "估值",
    group: "估值",
    order: 3,
    unit: "percent",
    series: valuations,
    default_thresholds: valuations.flatMap(({ key: series_key }) => [
      {
        default_key: series_key + "low",
        series_key,
        direction: "below",
        level: 20,
        hysteresis: 5,
        label: "便宜",
      },
      {
        default_key: series_key + "high",
        series_key,
        direction: "above",
        level: 80,
        hysteresis: 5,
        label: "偏贵",
      },
    ]),
  },
];

function point(trade_date: number, value: number): FinancePoint & { value: number } {
  return { trade_date, value, extra_json: null };
}
function done(...dates: number[]): FinanceDone {
  return { type: "done", status: "ok", new_dates: { [key]: dates.map(String) }, through: {} };
}
const days = [20261102, 20261103, 20261104, 20261105, 20261106] as const;

describe("金融阈值与真实 SQLite 事务", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let alerts: FinanceAlerts;
  let prices: FinancePoint[];
  beforeEach(async () => {
    f = await fixture();
    prices = [point(days[0], 44)];
    alerts = new FinanceAlerts(
      {
        listIndicators: async () => meta,
        getRecent: async (keys: string[]) =>
          keys.map((item) => ({ key: item, points: item === key ? prices.slice(-2) : [] })),
        getSeries: async (keys: string[], range?: DateRange) =>
          keys.map((item) => ({
            key: item,
            points:
              item === key
                ? prices.filter(
                    ({ trade_date }) =>
                      !range || (trade_date >= range.from && trade_date <= range.to),
                  )
                : [],
          })),
      },
      async () => f.data,
      () => f.clock.now,
    );
  });
  afterEach(() => f.db.close());

  it("九条默认值并发初始化幂等，修改与墓碑跨重载保留", async () => {
    await Promise.all([
      f.data.financeThresholds.ensureDefaults(meta),
      f.data.financeThresholds.ensureDefaults(meta),
    ]);
    expect(await alerts.list()).toHaveLength(9);
    const first = (await f.data.financeThresholds.list()).find((row) => row.series_key === key)!;
    expect(first.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7/);
    expect(await alerts.save({ ...main, level: 46 }, first.id)).toHaveLength(9);
    expect((await f.data.financeThresholds.get(first.id))?.level).toBe(46);
    expect((await f.data.financeAlertStates.list())[0]?.threshold_version).toBeGreaterThan(
      first.updated_at,
    );
    expect(await alerts.delete(first.id)).toHaveLength(8);
    expect(await alerts.list()).toHaveLength(8);
    expect(await f.data.financeThresholds.get(first.id)).toBeNull();
    expect(await f.data.financeAlertStates.list()).toEqual([]);
    expect(await f.data.financeThresholds.listDeleted()).toMatchObject([{ id: first.id }]);
    expect(await f.data.financeAlertStates.listDeleted()).toMatchObject([
      { threshold_id: first.id },
    ]);
  });

  it("44→46→46.5→43.5→45.5 只提醒两次，调度器先唤起再显示并可完成", async () => {
    await alerts.list();
    const actions: string[] = [];
    const scheduler = new ReminderScheduler(
      f.data,
      createInAppNotificationPort({
        showMain: async () => {
          actions.push("唤起");
        },
        push: () => actions.push("通知"),
      }),
      {
        now: () => f.clock.now,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      },
    );
    await scheduler.start();
    try {
      for (const [index, value] of [46, 46.5, 43.5, 45.5].entries()) {
        const day = days[index + 1]!;
        prices.push(point(day, value));
        f.clock.now += 1000;
        await alerts.complete(done(day));
        await scheduler.wake();
      }
      expect(actions).toEqual(["唤起", "通知", "唤起", "通知"]);
      expect(await f.data.reminders.list()).toHaveLength(2);
      const [first] = await loadReminderItems(f.data);
      expect(first?.reminder).toMatchObject({
        source: "manual",
        source_workbench: FINANCE_WORKBENCH,
        priority: 2,
      });
      expect(first?.occurrenceId).toBeTruthy();
      await completeReminder(
        f.data,
        { reminderId: first!.reminder.id, occurrenceId: first!.occurrenceId! },
        f.clock.now,
      );
      expect((await f.data.reminders.get(first!.reminder.id))?.completed_at).toBe(f.clock.now);
      expect(await f.data.financeAlertStates.targetForReminder(first!.reminder.id)).toEqual({
        indicatorId: key,
        seriesKey: key,
      });
    } finally {
      scheduler.stop();
    }
  });

  it("首次计算和完整重建静默，重算及未标为新日期的值不触发", async () => {
    prices = [point(days[0], 44), point(days[1], 46)];
    await alerts.complete(done(days[0], days[1]));
    expect(await f.data.reminders.list()).toEqual([]);
    expect((await f.data.financeAlertStates.list())[0]).toMatchObject({
      breached: true,
      evaluated_through: days[1],
    });
    prices = [point(days[0], 50), point(days[1], 40), point(days[2], 48)];
    await alerts.complete(done(days[0], days[1]));
    await alerts.complete(done(days[2]), "full-rebuild");
    expect(await f.data.reminders.list()).toEqual([]);
    expect((await f.data.financeAlertStates.list())[0]?.evaluated_through).toBe(days[2]);
  });

  it("三条越线合并，事务失败同时回滚状态、提醒和跳转，重试仅写一次", async () => {
    await alerts.list();
    for (const level of [45.2, 45.4]) await alerts.save({ ...main, level });
    prices.push(point(days[1], 46), point(days[2], 43), point(days[3], 48));
    f.db.failAt = 3;
    await expect(alerts.complete(done(days[3], days[2], days[1]))).rejects.toThrow("模拟事务失败");
    expect(await f.data.reminders.list()).toEqual([]);
    expect(await f.db.select("SELECT key FROM workbench_kv")).toEqual([]);
    expect(
      (await f.data.financeAlertStates.list()).map(({ evaluated_through }) => evaluated_through),
    ).toEqual([days[0], days[0], days[0]]);
    f.db.failAt = null;
    await alerts.list();
    await Promise.all([
      alerts.complete(done(days[1], days[2], days[3])),
      alerts.complete(done(days[1], days[2], days[3])),
    ]);
    const reminders = await f.data.reminders.list();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.title).toBe("金融指标：3 条阈值被触发");
    expect(reminders[0]?.notes.split("\n")).toHaveLength(3);
    expect(reminders[0]?.notes).toContain("首次越线 2026-11-03");
    expect(
      (await f.data.financeAlertStates.list()).every(
        (state) => state.last_reminder_id === reminders[0]?.id,
      ),
    ).toBe(true);
  });

  it("补算越线后回到阈值内不提醒，编辑后静默且停用不评估", async () => {
    const [threshold] = (await alerts.list()).filter(({ series_key }) => series_key === key);
    prices.push(point(days[1], 46), point(days[2], 44.5));
    await alerts.complete(done(days[1], days[2]));
    expect(await f.data.reminders.list()).toEqual([]);
    await alerts.save({ ...main, direction: "below", level: 45 }, threshold!.id);
    expect((await f.data.financeAlertStates.list())[0]).toMatchObject({
      breached: true,
      evaluated_through: days[2],
    });
    await alerts.save({ ...main, enabled: false }, threshold!.id);
    prices.push(point(days[3], 48));
    await alerts.complete(done(days[3]));
    expect(await f.data.reminders.list()).toEqual([]);
  });

  it("低于阈值在回差边界不重置，穿过边界后才能再次越线", async () => {
    const threshold = await f.data.financeThresholds.create({
      ...main,
      direction: "below",
      level: 45,
    });
    const initial = evaluateThreshold(threshold, undefined, point(days[0], 44), []);
    const equal = evaluateThreshold(threshold, initial?.next, point(days[1], 46), [
      point(days[1], 46),
    ]);
    expect(equal?.next.breached).toBe(true);
    const reset = evaluateThreshold(threshold, equal?.next, point(days[2], 46.1), [
      point(days[2], 46.1),
    ]);
    expect(reset?.next.breached).toBe(false);
    expect(
      evaluateThreshold(threshold, reset?.next, point(days[3], 44.9), [point(days[3], 44.9)])
        ?.crossing?.firstDate,
    ).toBe(days[3]);
  });

  it("只改备注时保留回差状态，两条阈值分别生成提醒", async () => {
    const [threshold] = (await alerts.list()).filter(({ series_key }) => series_key === key);
    await alerts.save({ ...main, level: 45.2, label: "第二条" });
    prices.push(point(days[1], 46), point(days[2], 44.5));
    await alerts.complete(done(days[1], days[2]));
    expect(await f.data.reminders.list()).toHaveLength(0);
    expect((await f.data.financeAlertStates.list()).every(({ breached }) => breached)).toBe(true);
    await alerts.save({ ...main, label: "备注更新" }, threshold!.id);
    expect((await f.data.financeAlertStates.list()).every(({ breached }) => breached)).toBe(true);
    prices.push(point(days[3], 43), point(days[4], 46));
    await alerts.complete(done(days[3], days[4]));
    const reminders = await f.data.reminders.list();
    expect(reminders).toHaveLength(2);
    expect(reminders.some(({ notes }) => notes.includes("备注更新"))).toBe(true);
  });
});

it("金融通知主体进入对应序列，完成、稍后和普通提醒沿用原入口", async () => {
  const target = { reminderId: "r", occurrenceId: "o", sourceWorkbench: FINANCE_WORKBENCH };
  const port = {
    resolve: vi.fn(async () => target),
    openFinance: vi.fn(),
    openReminder: vi.fn(),
    openMissed: vi.fn(),
    complete: vi.fn(),
    snooze: vi.fn(),
  };
  await dispatchNotification({ kind: "open", occurrenceId: "o" }, port);
  await dispatchNotification({ kind: "complete", occurrenceId: "o" }, port);
  await dispatchNotification({ kind: "snooze", occurrenceId: "o" }, port);
  await dispatchNotification({ kind: "missed", count: 2 }, port);
  expect(port.openFinance).toHaveBeenCalledExactlyOnceWith("r");
  expect(port.resolve).toHaveBeenNthCalledWith(1, "o", true);
  expect(port.complete).toHaveBeenCalledExactlyOnceWith(target);
  expect(port.snooze).toHaveBeenCalledExactlyOnceWith(target);
  expect(port.openMissed).toHaveBeenCalledExactlyOnceWith(2);
  port.resolve.mockResolvedValueOnce({ ...target, sourceWorkbench: "" });
  await dispatchNotification({ kind: "open", occurrenceId: "o" }, port);
  expect(port.openReminder).toHaveBeenCalledOnce();
  expect(
    preferencesForTarget({ indicatorId: "index_valuation", seriesKey: valuations[1]!.key }, meta),
  ).toEqual({
    indicator: "index_valuation",
    valuationIndex: "399006.SZ",
    valuationMetric: "pe_ttm",
    valuationView: "percentile",
    valuationWindow: "10y",
  });
});
