import { createRoot } from "react-dom/client";
import { getInstanceByDom } from "echarts/core";
import type {
  FinancePoint,
  IndicatorMeta,
  SeriesData,
} from "../../../apps/desktop/src/core/finance/finance-reader";
import { FinanceDashboard, type FinanceDashboardData } from "../src/FinanceDashboard";
import { readPreferences } from "../src/preferences";

// 仅用于浏览器验收。序列由数学函数生成，不连接 Tauri、SQLite 或行情接口。
const indices = [
  { value: "000300.SH", label: "沪深300" },
  { value: "399006.SZ", label: "创业板指" },
  { value: "000001.SH", label: "上证指数" },
];
const metrics = ["pe_ttm", "pb"] as const;
const windows = ["raw", "pct_5y", "pct_10y", "pct_all"] as const;
const valuationSeries = indices.flatMap((index) =>
  metrics.flatMap((metric) =>
    windows.map((window) => ({
      key: `valuation.${index.value}.${metric}.${window}`,
      index: index.value,
      metric,
      window,
      label: index.label,
    })),
  ),
);

const metadata: IndicatorMeta[] = [
  {
    id: "top5_turnover_share",
    name: "前 5% 个股成交额占比",
    group: "交易拥挤",
    order: 10,
    unit: "percent",
    decimals: 1,
    views: { monthly_avg: true, overlay_hs300: true },
    series: [{ key: "top5_turnover_share", label: "日值", primary: true }],
    default_thresholds: [
      { series_key: "top5_turnover_share", direction: "above", level: 45, label: "交易拥挤" },
    ],
    description_md:
      "**口径**：沪深 A 股中成交额前 5% 个股的成交额占比。\n**解读**：高于 45% 提示交易较拥挤。",
  },
  {
    id: "new_high_60d_share",
    name: "创 60 日新高个股占比",
    group: "市场宽度",
    order: 20,
    unit: "percent",
    decimals: 1,
    views: { overlay_hs300: true },
    series: [{ key: "new_high_60d_share", label: "日值", primary: true }],
    default_thresholds: [
      { series_key: "new_high_60d_share", direction: "above", level: 20, label: "普涨过热" },
      { series_key: "new_high_60d_share", direction: "below", level: 3, label: "市场很弱" },
    ],
    description_md: "**口径**：符合上市和交易天数条件的股票中，后复权收盘价达到 60 日新高的比例。",
  },
  {
    id: "index_valuation",
    name: "主要指数估值分位",
    group: "估值",
    order: 30,
    unit: "percent",
    decimals: 1,
    views: { overlay_hs300: true },
    series: valuationSeries,
    dimensions: {
      indices,
      metrics: [...metrics],
      windows: ["5y", "10y", "all"],
      views: ["percentile", "raw"],
    },
    default_thresholds: indices.flatMap(({ value }) => [
      {
        series_key: `valuation.${value}.pe_ttm.pct_10y`,
        direction: "above",
        level: 80,
        label: "估值偏贵",
      },
      {
        series_key: `valuation.${value}.pe_ttm.pct_10y`,
        direction: "below",
        level: 20,
        label: "估值便宜",
      },
    ]),
    description_md:
      "**口径**：截至当日，滚动窗口内不高于当日估值的有效天数占比。\n**解读**：窗口长度不同，分位曲线也不同。",
  },
];

const dates = Array.from({ length: 1140 }, (_, index) => {
  const date = new Date(Date.UTC(2005, 0, 4 + index * 7));
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}).filter((date) => date < 20261105);
dates.push(20261105, 20261106);

function points(key: string): FinancePoint[] {
  const meta = valuationSeries.find((series) => series.key === key);
  const start = meta?.index === "399006.SZ" ? 20100601 : meta ? 20050101 : 20150101;
  const ready =
    meta?.window === "pct_5y"
      ? start === 20100601
        ? 20141201
        : 20090701
      : meta?.window === "pct_10y"
        ? start === 20100601
          ? 20190601
          : 20140101
        : meta?.window === "pct_all"
          ? start === 20100601
            ? 20130601
            : 20080101
          : start;
  const raw = meta?.window === "raw";
  const shift = meta?.window === "pct_5y" ? 1.2 : meta?.window === "pct_all" ? 2.2 : 0;
  return dates
    .filter((day) => day >= start)
    .map((day, index) => {
      const oscillation =
        Math.sin(index / 11 + shift) + 0.45 * Math.cos(index / 3) + 0.6 * Math.sin(index / 61);
      const value =
        key === "top5_turnover_share"
          ? 43 + oscillation * 3.8
          : key === "new_high_60d_share"
            ? 9 + oscillation * 4.4
            : raw
              ? meta.metric === "pb"
                ? 1.8 + 0.25 * oscillation
                : 15 + 2.2 * oscillation
              : 50 + oscillation * 21;
      return { trade_date: day, value: day < ready ? null : value, extra_json: null };
    });
}

function series(keys: string[]): SeriesData[] {
  return keys.map((key) => ({ key, points: points(key) }));
}

const params = new URLSearchParams(location.search);
const storageKey = "workbench-finance-test-preferences";
const api: FinanceDashboardData = {
  listIndicators: async () => {
    if (params.has("error")) throw new Error("模拟缓存读取错误");
    return params.has("empty") ? [] : metadata;
  },
  getRecent: async (keys) =>
    series(keys).map((item) => ({
      ...item,
      points: item.points.filter((point) => point.value != null).slice(-2),
    })),
  getSeries: async (keys) => series(keys),
  getOverlay: async () =>
    dates
      .filter((day) => day >= 20150101)
      .map((day, index) => ({
        trade_date: day,
        value: 3300 + index * 1.25 + Math.sin(index / 31) * 640,
        extra_json: null,
      })),
  loadPreferences: async () =>
    readPreferences({
      ...JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
      ...Object.fromEntries(params),
    }),
  savePreference: async (field, value) =>
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
        [field]: value,
      }),
    ),
};
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
Object.defineProperty(window, "financePreviewChart", {
  value: () => {
    const container = document.querySelector<HTMLElement>("[role=img]");
    return container && getInstanceByDom(container);
  },
});

createRoot(document.getElementById("preview")!).render(
  <main className="mx-auto min-h-screen max-w-[1400px] space-y-5 bg-background p-6 text-foreground">
    <header className="flex items-center justify-between border-b border-border pb-4">
      <span className="text-lg font-semibold">WorkBench · 金融指标</span>
      <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
        合成测试数据
      </span>
    </header>
    <FinanceDashboard
      api={api}
      revision={0}
      busy={params.has("busy")}
      configured
      update={() => undefined}
      openSettings={() => undefined}
    />
  </main>,
);
