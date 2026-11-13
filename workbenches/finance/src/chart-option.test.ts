import { expect, it } from "vitest";
import { init, use } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { buildChartOption } from "./chart-option";
import { monthlyAverage } from "./monthly";
import { dayTime, rangeStart } from "./series-view";

use([
  LineChart,
  GridComponent,
  DataZoomComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
]);

const points = [
  { trade_date: 20261104, value: 40 },
  { trade_date: 20261105, value: null },
  { trade_date: 20261106, value: 44.2 },
].map((point) => ({ ...point, extra_json: null }));

it("保留缺值，叠加副轴并显示默认阈值与三年缩放范围", () => {
  const option = buildChartOption(
    points,
    [{ trade_date: 20261106, value: 4500, extra_json: null }],
    [{ level: 45, label: "交易拥挤", direction: "above" }],
    {
      name: "前 5% 个股成交额占比",
      percent: true,
      decimals: 1,
      dark: false,
      range: "3y",
      first: 20150101,
      last: 20261106,
    },
  );
  expect(option.series).toMatchObject([
    {
      connectNulls: false,
      data: [
        [dayTime(20261104), 40],
        [dayTime(20261105), null],
        [dayTime(20261106), 44.2],
      ],
      markLine: { data: [{ yAxis: 45 }] },
    },
    { yAxisIndex: 1 },
  ]);
  expect(option.dataZoom).toMatchObject([{ startValue: dayTime(20231106) }, { type: "slider" }]);
  expect(option.yAxis).toMatchObject([{ scale: true, dataMin: 45, dataMax: 45 }, {}]);
  expect(option.yAxis).not.toMatchObject([{ min: 0, max: 100 }, {}]);
  expect(option).toMatchSnapshot();
});

it("占比纵轴随缩放范围收紧，仍包含高于当前数据的阈值", () => {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 500, height: 350 });
  try {
    chart.setOption(
      buildChartOption(
        [{ trade_date: 20150105, value: 90, extra_json: null }, ...points],
        [],
        [{ level: 50, label: "测试阈值", direction: "above" }],
        {
          name: "测试占比",
          percent: true,
          decimals: 1,
          dark: false,
          range: "3y",
          first: 20150101,
          last: 20261106,
        },
      ),
    );
    const inView = (value: number) =>
      chart.containPixel({ gridIndex: 0 }, [
        250,
        Number(chart.convertToPixel({ yAxisIndex: 0 }, value)),
      ]);
    expect(inView(40)).toBe(true);
    expect(inView(50)).toBe(true);
    expect(inView(90)).toBe(false);
  } finally {
    chart.dispose();
  }
});

it.each(["日线", "月均"])("%s模式下叠加线按日期定位并在缺口断开", (mode) => {
  const overlay = [
    { trade_date: 20261029, value: 4400 },
    { trade_date: 20261030, value: 4420 },
    { trade_date: 20261102, value: null },
    { trade_date: 20261103, value: 4470 },
    { trade_date: 20261104, value: 4500 },
  ].map((point) => ({ ...point, extra_json: null }));
  const daily = [{ trade_date: 20261030, value: 41, extra_json: null }, ...points];
  const series = mode === "月均" ? monthlyAverage(daily, 20261201) : daily;
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 500, height: 350 });
  try {
    const option = buildChartOption(series, overlay, [], {
      name: mode,
      percent: true,
      decimals: 1,
      dark: false,
      range: "all",
      first: 20261029,
      last: 20261106,
    });
    expect(option.series).toMatchObject([
      {},
      {
        yAxisIndex: 1,
        connectNulls: false,
        data: overlay.map(({ trade_date, value }) => [dayTime(trade_date), value]),
      },
    ]);
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    const overlayPath = svg.match(/<path d="([^"]+)"[^>]*stroke="#75867f"[^>]*>/g);
    expect(overlayPath?.some((path) => (path.match(/M-?\d/g) ?? []).length === 2)).toBe(true);
  } finally {
    chart.dispose();
  }
});

it("估值分位纵轴保持 0 到 100", () => {
  const option = buildChartOption(points, [], [], {
    name: "沪深300 PE-TTM 分位",
    percent: true,
    percentile: true,
    decimals: 1,
    dark: false,
    range: "all",
    first: 20050101,
    last: 20261106,
  });
  expect(option.yAxis).toMatchObject([{ min: 0, max: 100, scale: false }]);
});

it("原始估值没有百分比轴，全部从 2005 年开始", () => {
  const option = buildChartOption(
    [{ trade_date: 20261106, value: 13.59, extra_json: null }],
    [],
    [],
    {
      name: "沪深300 PE-TTM 原始值",
      percent: false,
      decimals: 2,
      dark: true,
      range: "all",
      first: 20050101,
      last: 20261106,
    },
  );
  expect(option.xAxis).toMatchObject({ min: dayTime(20050101) });
  expect(option.yAxis).toEqual([expect.not.objectContaining({ max: 100 })]);
  expect(option).toMatchSnapshot();
  expect(rangeStart("1y", 20050101, 20240229)).toBe(dayTime(20230228));
});

it.each([false, true])("备用点的日线／月均和叠加线保留来源标注（月均=%s）", (monthly) => {
  const daily = [
    { trade_date: 20261112, value: 44, extra_json: null },
    { trade_date: 20261113, value: 46, extra_json: '{"source":"akshare"}' },
  ];
  const overlay = [{ trade_date: 20261113, value: 4520, extra_json: '{"source":"akshare"}' }];
  const option = buildChartOption(monthly ? monthlyAverage(daily, 20261113) : daily, overlay, [], {
    name: "前 5%",
    percent: true,
    decimals: 1,
    dark: true,
    range: "all",
    first: 20261112,
    last: 20261113,
  });
  const lines = option.series as {
    data: unknown[];
    tooltip: { valueFormatter: (value: unknown, index: number) => string };
  }[];
  const index = monthly ? 0 : 1;
  expect(lines[0]!.data[index]).toMatchObject({
    symbol: "diamond",
    name: monthly ? "月均含 AKShare 备用源" : "AKShare 备用源",
  });
  expect(lines[0]!.tooltip.valueFormatter(46, index)).toContain("AKShare 备用源");
  expect(lines[1]!.data[0]).toMatchObject({ symbol: "diamond", name: "AKShare 备用源" });
  expect(lines[1]!.tooltip.valueFormatter(4520, 0)).toContain("4520.00 点（AKShare 备用源）");
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 500, height: 350 });
  try {
    chart.setOption(option);
    expect(chart.renderToSVGString().match(/fill="#f0c477"/g)?.length).toBeGreaterThanOrEqual(2);
  } finally {
    chart.dispose();
  }
});
