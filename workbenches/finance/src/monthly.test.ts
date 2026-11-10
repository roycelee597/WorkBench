import { expect, it } from "vitest";
import { beijingDay, monthlyAverage } from "./monthly";

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
