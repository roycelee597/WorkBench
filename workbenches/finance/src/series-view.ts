import type {
  FinancePoint,
  IndicatorMeta,
} from "../../../apps/desktop/src/core/finance/finance-reader";
import type { FinancePreferences, FinanceRange } from "./preferences";

export const metricLabels = { pe_ttm: "PE-TTM", pb: "PB" } as const;
export const windowLabels = { "5y": "5 年", "10y": "10 年", all: "全部" } as const;
export const viewLabels = { percentile: "分位", raw: "原始值" } as const;

export function financeDate(day: number | null | undefined): string {
  if (!day) return "—";
  const value = String(day);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
}

export function dayTime(day: number): number {
  return Date.parse(`${financeDate(day)}T00:00:00Z`);
}

function choose<T>(values: readonly T[], preferred: T, fallback?: T): T | undefined {
  if (values.includes(preferred)) return preferred;
  if (fallback !== undefined && values.includes(fallback)) return fallback;
  return values[0];
}

export function resolveSeries(
  meta: IndicatorMeta,
  prefs: FinancePreferences,
  indexOverride?: string,
) {
  const dimensions = meta.dimensions;
  if (!dimensions) {
    const series = meta.series.find((entry) => entry.primary) ?? meta.series[0];
    return {
      series,
      raw: undefined,
      index: undefined,
      metric: undefined,
      window: undefined,
      view: undefined,
      percent: meta.unit === "percent",
      decimals: meta.decimals ?? 1,
      start: 20150101,
    };
  }
  const index =
    dimensions.indices.find(({ value }) => value === (indexOverride ?? prefs.valuationIndex)) ??
    dimensions.indices[0];
  const metric = choose(dimensions.metrics, prefs.valuationMetric, dimensions.default_metric);
  const window = choose(dimensions.windows, prefs.valuationWindow, dimensions.default_window);
  const view = choose(dimensions.views, prefs.valuationView, dimensions.default_view);
  const matching = meta.series.filter(
    (entry) => entry.index === index?.value && entry.metric === metric,
  );
  const raw = matching.find((entry) => entry.window === "raw");
  const series = view === "raw" ? raw : matching.find((entry) => entry.window === `pct_${window}`);
  return {
    series,
    raw,
    index,
    metric,
    window,
    view,
    percent: view !== "raw",
    decimals: view === "raw" ? 2 : (meta.decimals ?? 1),
    start: 20050101,
  };
}

export function rangeStart(range: FinanceRange, first: number, last: number): number {
  if (range === "all") return dayTime(first);
  const year = Math.floor(last / 10000) - Number(range[0]);
  const month = Math.floor(last / 100) % 100;
  const day = Math.min(last % 100, new Date(Date.UTC(year, month, 0)).getUTCDate());
  return Math.max(dayTime(first), Date.UTC(year, month - 1, day));
}

export function latestPoints(points: FinancePoint[]): {
  latest?: FinancePoint;
  previous?: FinancePoint;
} {
  const latest = points.at(-1);
  const previous = points.at(-2);
  return {
    ...(latest?.value != null ? { latest } : {}),
    ...(previous?.value != null ? { previous } : {}),
  };
}

export function displayValue(
  value: number | null | undefined,
  percent: boolean,
  decimals: number,
): string {
  return value == null ? "—" : `${value.toFixed(decimals)}${percent ? "%" : ""}`;
}
