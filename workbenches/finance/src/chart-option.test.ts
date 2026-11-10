import { expect, it } from "vitest";
import { buildChartOption } from "./chart-option";
import { dayTime, rangeStart } from "./series-view";

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
  expect(option).toMatchSnapshot();
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
