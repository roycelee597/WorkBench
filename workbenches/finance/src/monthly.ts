import type { FinancePoint } from "../../../apps/desktop/src/core/finance/finance-reader";

export type MonthlyPoint = FinancePoint & { month: number; monthToDate: boolean };

export function beijingDay(now: Date): number {
  const time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return time.getUTCFullYear() * 10000 + (time.getUTCMonth() + 1) * 100 + time.getUTCDate();
}

export function monthlyAverage(points: FinancePoint[], today: number): MonthlyPoint[] {
  const months = new Map<number, { last: number; sum: number; count: number }>();
  for (const point of points) {
    const month = Math.floor(point.trade_date / 100);
    const entry = months.get(month) ?? { last: point.trade_date, sum: 0, count: 0 };
    entry.last = Math.max(entry.last, point.trade_date);
    if (point.value != null) {
      entry.sum += point.value;
      entry.count += 1;
    }
    months.set(month, entry);
  }
  return [...months]
    .sort(([a], [b]) => a - b)
    .map(([month, entry]) => ({
      month,
      trade_date: entry.last,
      value: entry.count ? entry.sum / entry.count : null,
      extra_json: null,
      monthToDate: month === Math.floor(today / 100),
    }));
}
