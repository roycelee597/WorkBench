import { describe, expect, it } from "vitest";
import {
  buildRule,
  dateInZone,
  draftFields,
  draftPatch,
  newEventDraft,
  occurrenceDraft,
  parseLocal,
  readRepeat,
  scopedPatch,
  toggleAllDay,
} from "../src/calendar-model";
import {
  expandEvents,
  parseRule,
  seriesStarts,
} from "../../../apps/desktop/src/core/calendar/recurrence";
import { editSeries } from "../../../apps/desktop/src/core/calendar/series-mutations";
import { event } from "../../../apps/desktop/tests/calendar-fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse("2026-01-05T09:00:00Z");
const repeat = (preset: ReturnType<typeof readRepeat>["preset"]) => ({
  ...readRepeat(null, start, "UTC"),
  preset,
});
describe("日程表单与重复预设", () => {
  it.each(["daily", "workdays", "weekly", "monthly", "yearly"] as const)(
    "%s 以 RRULE 存储，次数、截止日期、永不结束可往返",
    (preset) => {
      for (const end of ["never", "count", "until"] as const) {
        const draft = { ...repeat(preset), end, count: "3", until: "2027-12-31" };
        const rule = buildRule(draft, start, "UTC")!;
        expect(readRepeat(rule, start, "UTC")).toMatchObject({
          preset,
          end,
          ...(end === "count" ? { count: "3" } : end === "until" ? { until: "2027-12-31" } : {}),
        });
        expect(rule).not.toContain("DTSTART");
      }
      expect(buildRule(repeat("none"), start, "UTC")).toBeNull();
    },
  );
  it("每周多选、工作日以及月末/闰年按日期展开", () => {
    const rule = buildRule(
      { ...repeat("weekly"), weekdays: [0, 2, 4], end: "count", count: "4" },
      start,
      "UTC",
    );
    expect(
      seriesStarts(
        event({ start_at: start, end_at: start + HOUR, rrule: rule }),
        start,
        start + 8 * DAY,
      ).map((value) => dateInZone(value, "UTC")),
    ).toEqual(["2026-01-05", "2026-01-07", "2026-01-09", "2026-01-12"]);
    const last = Date.parse("2026-01-31T09:00Z");
    const monthly = event({
      start_at: last,
      end_at: last + HOUR,
      rrule: buildRule({ ...repeat("monthly"), end: "count", count: "2" }, last, "UTC"),
    });
    expect(
      seriesStarts(monthly, last, last + 90 * DAY).map((value) => dateInZone(value, "UTC")),
    ).toEqual(["2026-01-31", "2026-03-31"]);
    const leap = Date.parse("2024-02-29T09:00Z");
    const yearly = event({
      start_at: leap,
      end_at: leap + HOUR,
      rrule: buildRule({ ...repeat("yearly"), end: "count", count: "2" }, leap, "UTC"),
    });
    expect(
      seriesStarts(yearly, leap, leap + 5 * 366 * DAY).map((value) => dateInZone(value, "UTC")),
    ).toEqual(["2024-02-29", "2028-02-29"]);
  });
  it("全天结束包含当天，跨夏令时的午夜使用日历天而不是 24 小时", () => {
    const draft = {
      ...newEventDraft(start, start + HOUR, false, null, "America/New_York"),
      title: "全天",
      allDay: true,
      start: "2026-03-08",
      end: "2026-03-08",
    };
    const fields = draftFields(draft);
    expect(fields.end_at - fields.start_at).toBe(23 * HOUR);
    expect(() =>
      draftFields({ ...draft, allDay: false, start: "2026-03-08T02:30", end: "2026-03-08T04:00" }),
    ).toThrow("夏令时");
  });
  it("拒绝不存在的日期、夏令时缺失时间、倒置时间与无效重复条件", () => {
    expect(() => parseLocal("2026-02-30", "UTC")).toThrow("日期");
    expect(() => parseLocal("2026-03-08T02:30", "America/New_York")).toThrow("夏令时");
    const draft = { ...newEventDraft(start, start + HOUR, false, null, "UTC"), title: "会议" };
    expect(() => draftFields({ ...draft, end: draft.start })).toThrow("结束");
    expect(() => buildRule({ ...repeat("weekly"), weekdays: [] }, start, "UTC")).toThrow("星期");
    expect(buildRule({ ...repeat("weekly"), weekdays: [1] }, start, "UTC")).toContain("BYDAY=TU");
    expect(buildRule(repeat("workdays"), start + 5 * DAY, "UTC")).toContain("BYDAY=MO,TU,WE,TH,FR");
    expect(readRepeat("FREQ=WEEKLY", start, "UTC").weekdays).toEqual([0]);
    for (const count of ["0", "1.5", "9007199254740992", "NaN"])
      expect(() => buildRule({ ...repeat("daily"), end: "count", count }, start, "UTC")).toThrow(
        "次数",
      );
    expect(() =>
      buildRule({ ...repeat("daily"), end: "until", until: "2026-01-04" }, start, "UTC"),
    ).toThrow("结束日期");
  });
  it("全天切换与默认提醒独立于用户机器时区", () => {
    const draft = newEventDraft(start, start + HOUR, false, 10, "Asia/Shanghai");
    expect(draft.start).toBe("2026-01-05T17:00");
    expect(draft.reminder).toBe(10);
    expect(toggleAllDay(draft, true)).toMatchObject({
      start: "2026-01-05",
      end: "2026-01-05",
      allDay: true,
    });
    expect(toggleAllDay(toggleAllDay(draft, true), false)).toMatchObject({
      start: "2026-01-05T09:00",
      end: "2026-01-05T10:00",
    });
  });
  it("只改例外标题不重写时间/重复规则，调整例外时长能应用到整个系列", () => {
    const series = event({
      start_at: start,
      end_at: start + HOUR,
      rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=4",
    });
    const child = event({
      id: "child",
      start_at: start + DAY,
      end_at: start + DAY + 2 * HOUR,
      recurrence_id: series.id,
      original_start_at: start,
      rrule: null,
    });
    const occurrence = expandEvents([series, child], { start, end: start + 3 * DAY })[0]!;
    const initial = occurrenceDraft(occurrence, series);
    expect(draftPatch({ ...initial, title: "改标题" }, initial)).toEqual({ title: "改标题" });
    const patch = draftPatch({ ...initial, end: "2026-01-06T12:00" }, initial);
    expect(scopedPatch(patch, occurrence, series, "all")).toEqual({ end_at: start + 3 * HOUR });
    expect(scopedPatch(patch, occurrence, series, "this")).toEqual({
      end_at: start + DAY + 3 * HOUR,
    });
  });
  it("拖动星期会平移 BYDAY，此后全部保留剩余 COUNT；仅此次不携带 RRULE", () => {
    const series = event({
      start_at: start,
      end_at: start + HOUR,
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    });
    const occurrence = expandEvents([series], { start: start + 7 * DAY, end: start + 8 * DAY })[0]!;
    const patch = { start_at: occurrence.start_at + DAY, end_at: occurrence.end_at + DAY };
    const following = scopedPatch(patch, occurrence, series, "following");
    expect(parseRule(following.rrule!).count).toBe(4);
    expect(following.rrule).toContain("BYDAY=TU,TH");
    const changes = editSeries(
      { series, exceptions: [] },
      occurrence.original_start_at,
      "following",
      following,
      { now: 1, deviceId: "device", newId: "future" },
    );
    expect(seriesStarts(changes.created[0]!, start, start + 40 * DAY)).toHaveLength(4);
    expect(scopedPatch({ ...patch, rrule: "FREQ=DAILY" }, occurrence, series, "this")).toEqual(
      patch,
    );
    const sameTime = scopedPatch(
      { start_at: occurrence.start_at + HOUR, end_at: occurrence.end_at + HOUR },
      occurrence,
      series,
      "following",
    );
    expect(sameTime.rrule).toBeUndefined();
  });
});
