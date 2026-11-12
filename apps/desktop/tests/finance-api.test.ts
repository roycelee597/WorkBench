// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DateRange, FinancePoint, IndicatorMeta } from "../src/core/finance/finance-reader";
import { fixture } from "./memory-database";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  data: vi.fn(),
  indicators: vi.fn(),
  recent: vi.fn(),
  series: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));
vi.mock("../src/core/repositories/initialize", () => ({
  initializeDataLayer: bridge.data,
}));
vi.mock("../src/core/finance/finance-reader", () => ({
  FinanceReader: class {
    listIndicators = bridge.indicators;
    getRecent = bridge.recent;
    getSeries = bridge.series;
    getOverlay = async () => [];
    getStatus = vi.fn();
    resume = vi.fn();
    suspendForRebuild = vi.fn(async () => undefined);
  },
}));

const key = "top5_turnover_share";
const metadata: IndicatorMeta = {
  id: key,
  name: "前 5% 成交额占比",
  group: "交易拥挤",
  order: 1,
  unit: "percent",
  series: [{ key, label: "日值" }],
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
};

describe("金融入口的持久游标与更新容错", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let module: typeof import("../../../workbenches/finance/src/api");
  let prices: FinancePoint[];
  let failing: boolean;
  let receive: (event: { payload: string }) => void;
  let stop: () => void;
  const send = (event: object) => receive({ payload: JSON.stringify(event) });
  const engineStarts = () =>
    bridge.invoke.mock.calls.filter(([name]) => name === "finance_update_start");
  const cursor = async () => (await f.data.financeAlertStates.list())[0]?.evaluated_through;
  const appendCrossing = () => prices.push({ trade_date: 20261103, value: 46, extra_json: null });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    f = await fixture();
    await f.data.settings.setValue("finance.initial_backfill_confirmed", true);
    prices = [{ trade_date: 20261102, value: 44, extra_json: null }];
    failing = false;
    stop = () => undefined;
    bridge.data.mockResolvedValue(f.data);
    bridge.indicators.mockResolvedValue([metadata]);
    bridge.recent.mockImplementation(async (keys: string[]) => {
      if (failing) throw new Error("模拟评估持续失败");
      return keys.map((seriesKey) => ({
        key: seriesKey,
        points: seriesKey === key ? prices.slice(-2) : [],
      }));
    });
    bridge.series.mockImplementation(async (keys: string[], range?: DateRange) =>
      keys.map((seriesKey) => ({
        key: seriesKey,
        points:
          seriesKey === key
            ? prices.filter(
                ({ trade_date }) => !range || (trade_date >= range.from && trade_date <= range.to),
              )
            : [],
      })),
    );
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === "finance_token_status") return { configured: true, tail: "test" };
      if (command === "finance_update_start") return "started";
      throw new Error("意外原生命令：" + command);
    });
    bridge.listen.mockImplementation(async (_event: string, callback: typeof receive) => {
      receive = callback;
      return () => undefined;
    });
    module = await import("../../../workbenches/finance/src/api");
  });

  afterEach(() => {
    stop();
    f.db.close();
  });

  async function start() {
    stop = module.financeApi.startRuntime();
    await vi.waitFor(async () => expect(await cursor()).toBe(20261102));
  }

  it.each([
    { name: "失败", status: "failed", code: 4, cancelled: false },
    { name: "取消", status: undefined, code: 130, cancelled: true },
    { name: "没有 done", status: undefined, code: 1, cancelled: false },
  ])("越线发布后$name，之后无新日期更新仍恰好一条提醒", async ({ status, code, cancelled }) => {
    await start();
    await module.financeApi.requestUpdate();
    appendCrossing();
    if (status) send({ type: "done", status, new_dates: {}, through: {} });
    send({ type: "engine_exit", code, cancelled });
    await vi.waitFor(async () => expect(await f.data.reminders.list()).toHaveLength(1));
    await module.financeApi.requestUpdate();
    send({ type: "done", status: "ok", new_dates: {}, through: { [key]: "20261103" } });
    send({ type: "engine_exit", code: 0, cancelled: false });
    await module.financeApi.loadThresholds();
    expect(await f.data.reminders.list()).toHaveLength(1);
    expect(await cursor()).toBe(20261103);
    expect(engineStarts()).toHaveLength(2);
  });

  it("App 启动直接补评估已发布的日子，不必等待启动更新", async () => {
    await module.financeApi.loadThresholds();
    appendCrossing();
    stop = module.financeApi.startRuntime();
    await vi.waitFor(async () => expect(await f.data.reminders.list()).toHaveLength(1));
    expect(await cursor()).toBe(20261103);
    expect(engineStarts()).toHaveLength(0);
  });

  it.each([
    { name: "失败", status: "failed", code: 4, cancelled: false },
    { name: "取消", status: undefined, code: 130, cancelled: true },
  ])(
    "$name后评估失败，下次无新日期的正常更新仍补出一条提醒",
    async ({ status, code, cancelled }) => {
      await start();
      await module.financeApi.requestUpdate();
      appendCrossing();
      failing = true;
      if (status) send({ type: "done", status, new_dates: {}, through: {} });
      send({ type: "engine_exit", code, cancelled });
      await vi.waitFor(() =>
        expect(module.useFinanceState.getState().error).toBe("模拟评估持续失败"),
      );
      expect(await cursor()).toBe(20261102);
      expect(await f.data.reminders.list()).toHaveLength(0);
      failing = false;
      await module.financeApi.requestUpdate();
      send({ type: "done", status: "ok", new_dates: {}, through: {} });
      send({ type: "engine_exit", code: 0, cancelled: false });
      await module.financeApi.loadThresholds();
      expect(await f.data.reminders.list()).toHaveLength(1);
      expect(await cursor()).toBe(20261103);
    },
  );

  it("评估持续失败仍启动更新，错误修复后自动从原游标补上", async () => {
    await start();
    appendCrossing();
    failing = true;
    for (let index = 0; index < 2; index++) {
      await module.financeApi.requestUpdate();
      expect(engineStarts()).toHaveLength(index + 1);
      expect(module.useFinanceState.getState().error).toBe("模拟评估持续失败");
      send({ type: "engine_exit", code: 130, cancelled: true });
    }
    expect(await cursor()).toBe(20261102);
    expect(await f.data.reminders.list()).toHaveLength(0);
    failing = false;
    await module.financeApi.requestUpdate();
    send({ type: "done", status: "ok", new_dates: {}, through: {} });
    send({ type: "engine_exit", code: 0, cancelled: false });
    await module.financeApi.loadThresholds();
    expect(engineStarts()).toHaveLength(3);
    expect(await f.data.reminders.list()).toHaveLength(1);
    expect(await cursor()).toBe(20261103);
  });

  it("行情评估失败仍能保存和删除阈值，并报告当前评估错误", async () => {
    await start();
    const [threshold] = await f.data.financeThresholds.list();
    failing = true;
    await expect(
      module.financeApi.saveThreshold(
        {
          indicator_id: key,
          series_key: key,
          direction: "above",
          level: 45,
          hysteresis: 1,
          enabled: true,
          label: "可保存",
        },
        threshold!.id,
      ),
    ).resolves.toHaveLength(1);
    expect((await f.data.financeThresholds.get(threshold!.id))?.label).toBe("可保存");
    expect(module.useFinanceState.getState().error).toBe("模拟评估持续失败");
    await expect(module.financeApi.deleteThreshold(threshold!.id)).resolves.toEqual([]);
  });
});
