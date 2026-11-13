import type { ComposeOption } from "echarts/core";
import type { LineSeriesOption } from "echarts/charts";
import type {
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import type { FinancePoint } from "../../../apps/desktop/src/core/finance/finance-reader";
import type { MonthlyPoint } from "./monthly";
import { dayTime, displayValue, rangeStart } from "./series-view";
import type { FinanceRange } from "./preferences";
import { isAkshare, sourceLabel } from "./data-source";

export type FinanceChartOption = ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DataZoomComponentOption
>;

export const overlayName = "沪深300 收盘";
type Threshold = { level: number; label: string; direction: "above" | "below" };
type ChartView = {
  name: string;
  percent: boolean;
  percentile?: boolean;
  decimals: number;
  dark: boolean;
  range: FinanceRange;
  first: number;
  last: number;
};

function formatTip(value: unknown, percent: boolean, decimals: number): string {
  const last = Array.isArray(value) ? value.at(-1) : value;
  return displayValue(typeof last === "number" ? last : undefined, percent, decimals);
}

export function buildChartOption(
  series: (FinancePoint | MonthlyPoint)[],
  overlay: FinancePoint[],
  thresholds: Threshold[],
  view: ChartView,
): FinanceChartOption {
  const ink = view.dark ? "#d8e4dc" : "#34443a";
  const grid = view.dark ? "#334238" : "#e2eae4";
  const primary = view.dark ? "#8bd5b2" : "#27785b";
  const muted = view.dark ? "#a1b1aa" : "#75867f";
  const warning = view.dark ? "#ffad9f" : "#a84236";
  const backup = view.dark ? "#f0c477" : "#8a5d13";
  const startValue = rangeStart(view.range, view.first, view.last);
  const endValue = dayTime(view.last);
  const share = view.percent && !view.percentile;
  const thresholdLevels = thresholds.map(({ level }) => level);
  const filterMode = share ? "filter" : "none";
  const plotPoint = (
    point: FinancePoint | MonthlyPoint,
  ): NonNullable<LineSeriesOption["data"]>[number] => {
    const value = [dayTime(point.trade_date), point.value];
    const month = "monthToDate" in point && point.monthToDate && point.value != null;
    const source = sourceLabel(point);
    if (!month && !source) return value;
    return {
      value,
      ...(month
        ? {
            symbol: "circle",
            symbolSize: 7,
            label: { show: true, formatter: "本月至今", position: "top" as const, color: ink },
          }
        : {}),
      ...(source
        ? { name: source, symbol: "diamond", symbolSize: 8, itemStyle: { color: backup } }
        : {}),
    };
  };
  const pointData = series.map(plotPoint);
  return {
    useUTC: true,
    animation: false,
    grid: { left: 56, right: overlay.length ? 62 : 24, top: 46, bottom: 72 },
    legend: {
      data: overlay.length ? [view.name, overlayName] : [view.name],
      textStyle: { color: ink },
      top: 4,
    },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      confine: true,
      backgroundColor: view.dark ? "#233029" : "#ffffff",
      borderColor: grid,
      textStyle: { color: ink },
    },
    xAxis: {
      type: "time",
      min: dayTime(view.first),
      max: endValue,
      axisLine: { lineStyle: { color: muted } },
      axisLabel: { color: ink, hideOverlap: true },
    },
    yAxis: [
      {
        type: "value",
        ...(view.percentile ? { min: 0, max: 100 } : {}),
        ...(share && thresholdLevels.length > 0
          ? {
              dataMin: Math.min(...thresholdLevels),
              dataMax: Math.max(...thresholdLevels),
              boundaryGap: [0, "8%"] as [number, string],
            }
          : {}),
        scale: !view.percentile,
        axisLabel: { color: ink, formatter: view.percent ? "{value}%" : "{value}" },
        splitLine: { lineStyle: { color: grid } },
      },
      ...(overlay.length
        ? [
            {
              type: "value" as const,
              scale: true,
              position: "right" as const,
              axisLabel: { color: muted },
              splitLine: { show: false },
            },
          ]
        : []),
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: 0, startValue, endValue, filterMode },
      {
        type: "slider",
        xAxisIndex: 0,
        startValue,
        endValue,
        filterMode,
        bottom: 12,
        height: 26,
        borderColor: grid,
        textStyle: { color: ink },
        fillerColor: view.dark ? "#8bd5b240" : "#27785b26",
      },
    ],
    series: [
      {
        name: view.name,
        type: "line",
        showSymbol: true,
        symbol: series.filter((point) => point.value != null).length === 1 ? "circle" : "none",
        connectNulls: false,
        data: pointData,
        lineStyle: { color: primary, width: 2 },
        itemStyle: { color: primary },
        tooltip: {
          valueFormatter: (value, index) =>
            `${formatTip(value, view.percent, view.decimals)}${sourceLabel(series[index]) ? `（${sourceLabel(series[index])}）` : ""}`,
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { type: "dashed", color: warning },
          label: { position: "insideEndTop", color: warning, formatter: "{b}" },
          data: thresholds.map(({ level, label, direction }) => ({
            yAxis: level,
            name: `${label} ${direction === "above" ? ">" : "<"} ${displayValue(level, view.percent, view.decimals)}`,
          })),
        },
      },
      ...(overlay.length
        ? [
            {
              name: overlayName,
              type: "line" as const,
              yAxisIndex: 1,
              showSymbol: overlay.some(isAkshare),
              ...(overlay.some(isAkshare) ? { symbol: "none" } : {}),
              connectNulls: false,
              data: overlay.map(plotPoint),
              lineStyle: { color: muted, width: 1 },
              itemStyle: { color: muted },
              tooltip: {
                valueFormatter: (value: unknown, index: number) =>
                  `${formatTip(value, false, 2)} 点${sourceLabel(overlay[index]) ? `（${sourceLabel(overlay[index])}）` : ""}`,
              },
            },
          ]
        : []),
    ],
  };
}
