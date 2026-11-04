import { describe, expect, it } from "vitest";
import { expandEvents, seriesStarts, timestampFromFloating } from "../src/core/calendar/recurrence";
import { at, DAY, event, exception, range } from "./calendar-fixtures";

describe("日程展开", () => {
  it("重复实例保留起始时间的毫秒精度", () => {
    const root = event({
      start_at: at(1) + 123,
      end_at: at(1, 10) + 123,
      rrule: "FREQ=DAILY;COUNT=2",
    });
    expect(seriesStarts(root, range.start, range.end)).toEqual([at(1) + 123, at(2) + 123]);
  });
  it("COUNT、EXDATE、结束时间为半开边界，并返回独立对象", () => {
    const root = event({ exdates: [at(2)] });
    const result = expandEvents([root], { start: at(1), end: at(5) });
    expect(result.map((item) => item.start_at)).toEqual([at(1), at(3), at(4)]);
    result[0]!.event.exdates.push(42);
    expect(root.exdates).toEqual([at(2)]);
    expect(
      seriesStarts(event({ rrule: "FREQ=DAILY;UNTIL=20260103T090000Z" }), range.start, range.end),
    ).toEqual([at(1), at(2), at(3)]);
  });
  it("覆盖范围前开始的日程、瞬时日程和普通非重复日程", () => {
    expect(
      expandEvents([event({ rrule: null })], { start: at(1, 9) + 1, end: at(1, 11) }),
    ).toHaveLength(1);
    expect(
      expandEvents([event({ rrule: null })], { start: at(1, 10), end: at(1, 11) }),
    ).toHaveLength(0);
    expect(
      expandEvents([event({ rrule: null, end_at: at(1) })], { start: at(1), end: at(1) + 1 }),
    ).toHaveLength(1);
    expect(() => expandEvents([], { start: 1, end: 1 })).toThrow();
  });
  it("例外替换原实例，移出仍屏蔽、移入按实际时间展示", () => {
    const movedOut = exception(2, { start_at: at(20), end_at: at(20, 12) });
    const movedIn = exception(5, { start_at: at(2, 13), end_at: at(2, 14) });
    const result = expandEvents([event(), movedOut, movedIn], { start: at(1, 0), end: at(4, 0) });
    expect(
      result.map((item) => [item.original_start_at, item.start_at, item.is_exception]),
    ).toEqual([
      [at(1), at(1), false],
      [at(5), at(2, 13), true],
      [at(3), at(3), false],
    ]);
    const normal = expandEvents([event({ exdates: [at(2)] }), exception(2)], range);
    expect(normal.filter((item) => item.original_start_at === at(2))).toEqual([
      expect.objectContaining({ is_exception: true }),
    ]);
  });
  it("不展开已删除父日程或孤立例外，已删除例外保留父 EXDATE", () => {
    expect(expandEvents([event({ deleted_at: 2 }), exception(2)], range)).toEqual([]);
    expect(expandEvents([exception(2)], range)).toEqual([]);
    expect(
      expandEvents([event({ exdates: [at(2)] }), exception(2, { deleted_at: 3 })], range).map(
        (item) => item.start_at,
      ),
    ).not.toContain(at(2));
  });
  it("周、月底和闰年规则遵循日历而非固定毫秒间隔", () => {
    expect(
      seriesStarts(event({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3" }), at(1, 0), at(20, 0)),
    ).toEqual([at(5), at(7), at(12)]);
    const monthly = event({ start_at: at(31), end_at: at(31, 10), rrule: "FREQ=MONTHLY;COUNT=3" });
    expect(
      seriesStarts(monthly, at(1, 0), Date.UTC(2026, 6, 1)).map((value) =>
        new Date(value).toISOString().slice(0, 10),
      ),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    const yearly = event({
      start_at: Date.UTC(2024, 1, 29, 9),
      end_at: Date.UTC(2024, 1, 29, 10),
      rrule: "FREQ=YEARLY;COUNT=2",
    });
    expect(seriesStarts(yearly, Date.UTC(2024, 0, 1), Date.UTC(2029, 0, 1))).toEqual([
      Date.UTC(2024, 1, 29, 9),
      Date.UTC(2028, 1, 29, 9),
    ]);
  });
  it("上海时间不受主机时区影响，夏令时不存在的时间跳过且不占 COUNT", () => {
    const shanghai = event({
      start_at: at(1, 1),
      end_at: at(1, 2),
      timezone: "Asia/Shanghai",
      rrule: "FREQ=DAILY;COUNT=2",
    });
    expect(seriesStarts(shanghai, at(1, 0), at(4, 0))).toEqual([at(1, 1), at(2, 1)]);
    const spring = event({
      timezone: "America/New_York",
      start_at: Date.parse("2026-03-07T07:30:00Z"),
      end_at: Date.parse("2026-03-07T08:30:00Z"),
      rrule: "FREQ=DAILY;COUNT=3",
    });
    expect(seriesStarts(spring, Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 12))).toEqual([
      Date.parse("2026-03-07T07:30:00Z"),
      Date.parse("2026-03-09T06:30:00Z"),
      Date.parse("2026-03-10T06:30:00Z"),
    ]);
    expect(timestampFromFloating(Date.UTC(2026, 10, 1, 1, 30), "America/New_York")).toBe(
      Date.parse("2026-11-01T05:30:00Z"),
    );
  });
  it("跨夏令时的全天日程保持当地午夜边界", () => {
    const root = event({
      all_day: true,
      timezone: "America/New_York",
      start_at: Date.parse("2026-03-07T05:00:00Z"),
      end_at: Date.parse("2026-03-08T05:00:00Z"),
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const result = expandEvents([root], { start: root.start_at, end: root.start_at + 4 * DAY });
    expect(result.map((item) => item.end_at - item.start_at)).toEqual([DAY, DAY - 3_600_000, DAY]);
  });
  it.each([
    "FREQ=DAILY;COUNT=0",
    "FREQ=HOURLY",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY\nDTSTART:20260101T000000Z",
  ])("拒绝无效或不支持的规则 %s", (rrule) => {
    expect(() => seriesStarts(event({ rrule }), range.start, range.end)).toThrow();
  });
});
