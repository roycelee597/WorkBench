export type ValuationMetric = "pe_ttm" | "pb";
export type ValuationWindow = "5y" | "10y" | "all";
export type ValuationView = "percentile" | "raw";
export type FinanceUpdateMode = "auto" | "full-rebuild";
export type FinanceStage = "calendar" | "stock_basic" | "index" | "recent" | "backfill" | "compute";
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

export interface FinanceTokenStatus {
  configured: boolean;
  tail: string | null;
}

export interface FinanceModuleSnapshot {
  token: FinanceTokenStatus | null;
  confirmBackfill: boolean;
  error: string | null;
  update: FinanceUpdateSnapshot;
}

export interface FinanceUpdateSnapshot {
  status: "idle" | "running" | "complete" | "partial" | "failed" | "already_running";
  stage?: FinanceStage | undefined;
  progress?:
    | {
        done: number;
        total: number;
        current: string;
        eta_seconds: number;
      }
    | undefined;
  diagnostic?: { code: string; message: string } | undefined;
  revision: number;
}

export interface FinanceIndicator {
  id: string;
  name: string;
  group: string;
  order: number;
  unit?: string | undefined;
  decimals?: number | undefined;
  series: {
    key: string;
    label: string;
    primary?: boolean | undefined;
    index?: string | undefined;
    metric?: ValuationMetric | undefined;
    window?: "raw" | "pct_5y" | "pct_10y" | "pct_all" | undefined;
  }[];
  views?:
    | {
        monthly_avg?: boolean | undefined;
        overlay_hs300?: boolean | undefined;
      }
    | undefined;
  dimensions?:
    | {
        indices: { value: string; label: string }[];
        metrics: ValuationMetric[];
        windows: ValuationWindow[];
        views: ValuationView[];
        default_metric?: ValuationMetric | undefined;
        default_window?: ValuationWindow | undefined;
        default_view?: ValuationView | undefined;
      }
    | undefined;
  default_thresholds?:
    | {
        series_key: string;
        default_key?: string | undefined;
        level: number;
        hysteresis?: number | undefined;
        label: string;
        direction: "above" | "below";
      }[]
    | undefined;
  description_md?: string | undefined;
}

export interface FinancePoint {
  trade_date: number;
  value: number | null;
  extra_json: string | null;
}

export interface FinanceSeries {
  key: string;
  points: FinancePoint[];
}

export interface FinanceCacheStatus {
  bytes: number;
  firstDate: number | null;
  latestDate: number | null;
}

export interface FinanceThresholdInput {
  indicator_id: string;
  series_key: string;
  direction: "above" | "below";
  level: number;
  hysteresis: number;
  enabled: boolean;
  label: string;
}

export interface FinanceModuleThreshold extends FinanceThresholdInput {
  id: string;
}

export function outsideFinanceThreshold(
  value: number,
  threshold: Pick<FinanceThresholdInput, "direction" | "level">,
) {
  return threshold.direction === "above" ? value > threshold.level : value < threshold.level;
}
