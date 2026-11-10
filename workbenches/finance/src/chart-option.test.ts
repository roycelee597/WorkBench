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
