import type { FinanceTarget } from "../../../apps/desktop/src/core/finance/finance-target";
import type {
  IndicatorMeta,
  ValuationMetric,
  ValuationView,
  ValuationWindow,
} from "../../../apps/desktop/src/core/finance/finance-reader";

export type FinanceRange = "1y" | "3y" | "5y" | "all";
export type FinancePreferences = {
  range: FinanceRange;
  overlay: boolean;
  top5View: "daily" | "monthly";
  valuationWindow: ValuationWindow;
  valuationMetric: ValuationMetric;
  valuationView: ValuationView;
  valuationIndex: string;
  indicator: string;
};

export function preferencesForTarget(
  target: FinanceTarget,
  indicators: IndicatorMeta[],
): Partial<FinancePreferences> {
  const indicator = indicators.find(({ id }) => id === target.indicatorId);
  const series = indicator?.series.find(({ key }) => key === target.seriesKey);
  const result: Partial<FinancePreferences> = { indicator: target.indicatorId };
  if (series?.index) result.valuationIndex = series.index;
  if (series?.metric) result.valuationMetric = series.metric;
  if (series?.window) {
    result.valuationView = series.window === "raw" ? "raw" : "percentile";
    if (series.window === "pct_5y") result.valuationWindow = "5y";
    if (series.window === "pct_10y") result.valuationWindow = "10y";
    if (series.window === "pct_all") result.valuationWindow = "all";
  }
  return result;
}

export const preferenceKeys = {
  range: "finance.default_range",
  overlay: "finance.overlay_hs300",
  top5View: "finance.top5_view",
  valuationWindow: "finance.valuation_window",
  valuationMetric: "finance.valuation_metric",
  valuationView: "finance.valuation_view",
  valuationIndex: "finance.valuation_index",
  indicator: "finance.last_selected_indicator",
} satisfies Record<keyof FinancePreferences, string>;

export function readPreferences(
  values: Partial<Record<keyof FinancePreferences, unknown>>,
): FinancePreferences {
  return {
    range:
      values.range === "1y" || values.range === "5y" || values.range === "all"
        ? values.range
        : "3y",
    overlay: values.overlay !== false,
    top5View: values.top5View === "monthly" ? "monthly" : "daily",
    valuationWindow:
      values.valuationWindow === "5y" || values.valuationWindow === "all"
        ? values.valuationWindow
        : "10y",
    valuationMetric: values.valuationMetric === "pb" ? "pb" : "pe_ttm",
    valuationView: values.valuationView === "raw" ? "raw" : "percentile",
    valuationIndex: typeof values.valuationIndex === "string" ? values.valuationIndex : "",
    indicator: typeof values.indicator === "string" ? values.indicator : "",
  };
}
