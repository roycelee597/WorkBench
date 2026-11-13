import { expect, it } from "vitest";
import { beijingDay, monthlyAverage } from "./monthly";
import { isAkshare, sourceLabel } from "./data-source";

it("按自然月简单平均，保留全空月并标记北京时间的本月至今", () => {
  const points = [
    { trade_date: 20261106, value: 42 },
    { trade_date: 20260930, value: 48 },
    { trade_date: 20261030, value: null },
    { trade_date: 20261105, value: 44.2 },
    { trade_date: 20261109, value: null },
  ].map((point) => ({ ...point, extra_json: null }));
  const today = beijingDay(new Date("2026-10-31T16:00:00Z"));
  expect(today).toBe(20261101);
  const result = monthlyAverage(points, today);
  expect(result.map((point) => point.value)).toEqual([48, null, 43.1]);
  expect(result.map((point) => point.monthToDate)).toEqual([false, false, true]);
  expect(result).toMatchSnapshot();
});

it("月均保留备用来源，空值和损坏来源不会错误标注", () => {
  const ak = '{"source":"akshare"}';
  const mixed = monthlyAverage(
    [
      { trade_date: 20261112, value: 40, extra_json: null },
      { trade_date: 20261113, value: 50, extra_json: ak },
      { trade_date: 20261012, value: null, extra_json: ak },
      { trade_date: 20260912, value: 30, extra_json: "{坏 JSON" },
    ],
    20261113,
  );
  expect(mixed.map((point) => [point.value, isAkshare(point), sourceLabel(point)])).toEqual([
    [30, false, ""],
    [null, false, ""],
    [45, true, "月均含 AKShare 备用源"],
  ]);
});
