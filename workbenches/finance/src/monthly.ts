import type { FinancePoint } from "../../../apps/desktop/src/core/finance/finance-reader";
import { isAkshare } from "./data-source";

export type MonthlyPoint = FinancePoint & { month: number; monthToDate: boolean };

export function beijingDay(now: Date): number {
  const time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return time.getUTCFullYear() * 10000 + (time.getUTCMonth() + 1) * 100 + time.getUTCDate();
}

export function monthlyAverage(points: FinancePoint[], today: number): MonthlyPoint[] {
  const months = new Map<number, { last: number; sum: number; count: number; akshare: boolean }>();
  for (const point of points) {
    const month = Math.floor(point.trade_date / 100);
    const entry = months.get(month) ?? { last: point.trade_date, sum: 0, count: 0, akshare: false };
    entry.last = Math.max(entry.last, point.trade_date);
    if (point.value != null) {
      entry.sum += point.value;
      entry.count += 1;
      entry.akshare ||= isAkshare(point);
    }
    months.set(month, entry);
  }
  return [...months]
    .sort(([a], [b]) => a - b)
    .map(([month, entry]) => ({
      month,
      trade_date: entry.last,
      value: entry.count ? entry.sum / entry.count : null,
      extra_json: entry.akshare ? JSON.stringify({ source: "akshare" }) : null,
      monthToDate: month === Math.floor(today / 100),
    }));
}
