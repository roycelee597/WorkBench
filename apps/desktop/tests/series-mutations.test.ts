import { describe, expect, it } from "vitest";
import {
  deleteSeries,
  editSeries,
  type EventChangeSet,
  type SeriesState,
} from "../src/core/calendar/series-mutations";
import { expandEvents } from "../src/core/calendar/recurrence";
import { at, event, exception, range } from "./calendar-fixtures";

const context = { now: at(9), deviceId: "new-device", newId: "new-series" };
function apply(state: SeriesState, changes: EventChangeSet) {
  const rows = new Map([state.series, ...state.exceptions].map((row) => [row.id, row]));
  [...changes.created, ...changes.updated].forEach((row) => rows.set(row.id, row));
  return [...rows.values()];
}
function freeze(state: SeriesState): SeriesState {
  [state.series, ...state.exceptions].forEach((row) => {
    Object.freeze(row.exdates);
    Object.freeze(row);
  });
  Object.freeze(state.exceptions);
  return Object.freeze(state);
}

describe("重复日程的三种修改", () => {
  it("全天实例在夏令时周调整时长后，全部系列仍以当地午夜结束", () => {
    const root = event({
      all_day: true,
      timezone: "America/New_York",
      start_at: Date.parse("2026-03-01T05:00Z"),
      end_at: Date.parse("2026-03-02T05:00Z"),
      rrule: "FREQ=DAILY;COUNT=10",
    });
    const original = Date.parse("2026-03-08T05:00Z");
    const end = Date.parse("2026-03-10T04:00Z");
    const state = { series: root, exceptions: [] };
    const changes = editSeries(state, original, "all", { end_at: end }, context);
    expect(changes.updated[0]?.end_at).toBe(Date.parse("2026-03-03T05:00Z"));
    const selected = expandEvents(apply(state, changes), {
      start: original,
      end: original + 1,
    }).find((occurrence) => occurrence.start_at === original)!;
    expect(selected.end_at).toBe(end);
    expect(
      editSeries(state, original, "following", { end_at: end }, context).created[0]?.end_at,
    ).toBe(end);
  });
  it("仅此次和此后全部修改全天日程时保留夏令时日历边界", () => {
    const root = event({
      all_day: true,
      timezone: "America/New_York",
      start_at: Date.parse("2026-03-07T05:00:00Z"),
      end_at: Date.parse("2026-03-08T05:00:00Z"),
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const original = Date.parse("2026-03-08T05:00:00Z");
    for (const scope of ["this", "following"] as const) {
      const result = editSeries(
        { series: root, exceptions: [] },
        original,
        scope,
        { title: "改标题" },
        context,
      );
      expect(result.created[0]).toMatchObject({
        start_at: original,
        end_at: Date.parse("2026-03-09T04:00:00Z"),
      });
    }
  });
  it("仅此次生成例外和 EXDATE，再次修改复用例外，纯函数不改输入", () => {
    const state = freeze({ series: event(), exceptions: [] });
    const result = editSeries(
      state,
      at(2),
      "this",
      { title: "改一次", start_at: at(2, 11) },
      context,
    );
    expect(result.created[0]).toMatchObject({
      recurrence_id: "series",
      original_start_at: at(2),
      start_at: at(2, 11),
      end_at: at(2, 12),
      title: "改一次",
      rrule: null,
      created_at: context.now,
    });
    expect(result.updated[0]!.exdates).toEqual([at(2)]);
    expect(
      editSeries(state, at(2), "this", { title: "改一次", start_at: at(2, 11) }, context),
    ).toEqual(result);
    const again = editSeries(
      { series: result.updated[0]!, exceptions: result.created },
      at(2),
      "this",
      { title: "再改" },
      { ...context, newId: "unused" },
    );
    expect(again.created).toEqual([]);
    expect(again.updated[0]!.exdates).toEqual([at(2)]);
    expect(again.updated[1]).toMatchObject({ id: "new-series", title: "再改" });
    expect(expandEvents(apply(state, result), range)).toHaveLength(5);
  });
  it("此后全部截断旧系列并保留 COUNT 剩余次数，迁移未来例外和排除日期", () => {
    const state = freeze({
      series: event({ exdates: [at(2), at(4)] }),
      exceptions: [exception(2), exception(4)],
    });
    const result = editSeries(
      state,
      at(3),
      "following",
      { title: "未来", start_at: at(3, 10) },
      context,
    );
    expect(result.created[0]).toMatchObject({
      id: "new-series",
      start_at: at(3, 10),
      exdates: [at(4, 10)],
    });
    expect(result.created[0]!.rrule).toContain("COUNT=3");
    expect(result.updated.find((row) => row.id === "exception-4")).toMatchObject({
      recurrence_id: "new-series",
      original_start_at: at(4, 10),
      start_at: at(4, 11),
    });
    expect(result.updated.find((row) => row.id === "exception-2")).toBeUndefined();
    const occurrences = expandEvents(apply(state, result), range);
    expect(occurrences.map((row) => row.start_at)).toEqual([
      at(1),
      at(2, 11),
      at(3, 10),
      at(4, 11),
      at(5, 10),
    ]);
    expect(state.series.rrule).toBe("FREQ=DAILY;COUNT=5");
  });
  it("新规则不再包含的未来例外软删除，过去例外不动", () => {
    const state = { series: event(), exceptions: [exception(2), exception(4)] };
    const result = editSeries(state, at(3), "following", { rrule: "FREQ=WEEKLY;COUNT=2" }, context);
    expect(result.updated.find((row) => row.id === "exception-4")).toMatchObject({
      deleted_at: context.now,
      deletion_group_id: context.newId,
    });
    expect(result.updated.find((row) => row.id === "exception-2")).toBeUndefined();
  });
  it("全部修改移动整个系列，保留例外实际内容和时间并重新关联原实例", () => {
    const state = freeze({
      series: event({ exdates: [at(2)] }),
      exceptions: [exception(2, { title: "单次自定义" })],
    });
    const result = editSeries(
      state,
      at(4),
      "all",
      { title: "全系列", start_at: at(4, 10), end_at: at(4, 12) },
      context,
    );
    expect(result.created).toEqual([]);
    expect(result.updated[0]).toMatchObject({
      start_at: at(1, 10),
      end_at: at(1, 12),
      title: "全系列",
      exdates: [at(2, 10)],
    });
    expect(result.updated[1]).toMatchObject({
      title: "单次自定义",
      start_at: at(2, 11),
      end_at: at(2, 12),
      original_start_at: at(2, 10),
    });
    expect(expandEvents(apply(state, result), range)).toHaveLength(5);
  });
  it("首个实例的此后全部等价于全部，并拒绝非实例或已删除的系列", () => {
    const state = { series: event(), exceptions: [] };
    expect(editSeries(state, at(1), "following", { notes: "改" }, context)).toEqual(
      editSeries(state, at(1), "all", { notes: "改" }, context),
    );
    expect(() => editSeries(state, at(2, 8), "this", {}, context)).toThrow("实例");
    expect(() =>
      editSeries({ ...state, series: event({ deleted_at: 2 }) }, at(2), "all", {}, context),
    ).toThrow();
    expect(() => editSeries(state, at(2), "this", { rrule: "FREQ=DAILY" }, context)).toThrow();
  });
  it("全部改规则后保留的不匹配例外仍可操作，拆分时只扣除实际出现过的次数", () => {
    const state = freeze({
      series: event({ rrule: "FREQ=WEEKLY;BYDAY=TH;COUNT=5", exdates: [at(2)] }),
      exceptions: [exception(2)],
    });
    expect(
      editSeries(state, at(2), "this", { title: "保留例外再编辑" }, context).updated[1]?.title,
    ).toBe("保留例外再编辑");
    expect(editSeries(state, at(2), "all", { title: "整个系列" }, context).updated[0]?.title).toBe(
      "整个系列",
    );
    expect(
      editSeries(state, at(2), "following", { title: "后续安排" }, context).created[0]?.rrule,
    ).toContain("COUNT=4");
    for (const scope of ["this", "following", "all"] as const)
      expect(() => deleteSeries(state, at(2), scope, context)).not.toThrow();
  });
});

describe("重复日程的三种删除", () => {
  const state = freeze({
    series: event({ exdates: [at(2)] }),
    exceptions: [exception(2), exception(4)],
  });
  it("仅此次增加 EXDATE，软删除该实例的例外", () => {
    const result = deleteSeries(state, at(2), "this", context);
    expect(result.updated[0]!.exdates).toEqual([at(2)]);
    expect(result.updated[1]).toMatchObject({ id: "exception-2", deleted_at: context.now });
    expect(expandEvents(apply(state, result), range).map((row) => row.original_start_at)).toEqual([
      at(1),
      at(3),
      at(4),
      at(5),
    ]);
  });
  it("此后全部严格截断到目标前，未来例外删除而过去例外保留", () => {
    const result = deleteSeries(state, at(3), "following", context);
    expect(result.updated.find((row) => row.id === "exception-4")).toMatchObject({
      deleted_at: context.now,
    });
    expect(expandEvents(apply(state, result), range).map((row) => row.original_start_at)).toEqual([
      at(1),
      at(2),
    ]);
  });
  it("全部软删除父系列和全部有效例外，首个实例此后全部相同", () => {
    const result = deleteSeries(state, at(3), "all", context);
    expect(result.updated).toHaveLength(3);
    expect(
      result.updated.every(
        (row) => row.deleted_at === context.now && row.deletion_group_id === context.newId,
      ),
    ).toBe(true);
    expect(expandEvents(apply(state, result), range)).toEqual([]);
    expect(deleteSeries(state, at(1), "following", context)).toEqual(result);
  });
});
