// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, type MemoryDatabase } from "../../../apps/desktop/tests/memory-database";
import { createGeneralApi } from "../src/api";
import { localDayRange, watchToday } from "../src/today-model";

const databases: MemoryDatabase[] = [];
async function setup() {
  const result = await fixture();
  databases.push(result.db);
  result.clock.now = new Date(2026, 10, 5, 12).getTime();
  return {
    ...result,
    api: createGeneralApi(async () => result.data, {
      now: () => result.clock.now,
      offerAutostart: () => undefined,
    }),
  };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("今天汇总", () => {
  it("日程展开例外与跨日，全天置顶，并排除删除和明日边界", async () => {
    const { api, data, clock } = await setup();
    const { start, end } = localDayRange(clock.now);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const create = (title: string, a: number, b: number, all_day = false) =>
      data.events.create({ title, start_at: a, end_at: b, all_day, timezone: zone });
    await create("早晨", start + 8 * 3_600_000, start + 9 * 3_600_000);
    await create("跨日", start - 3_600_000, start + 3_600_000);
    await create("全天", start, end, true);
    await create("明日", end, end + 3_600_000);
    const deleted = await create("已删除", start, start + 1000);
    await data.events.softDelete(deleted.id);
    const series = await data.events.create({
      title: "系列",
      start_at: start - 86_400_000 + 10 * 3_600_000,
      end_at: start - 86_400_000 + 11 * 3_600_000,
      timezone: zone,
      rrule: "FREQ=DAILY;COUNT=3",
    });
    await data.events.editOccurrence(series.id, start + 10 * 3_600_000, "this", {
      title: "例外",
      start_at: start + 13 * 3_600_000,
    });
    expect((await api.loadToday()).events.map((row) => row.event.title)).toEqual([
      "全天",
      "跨日",
      "早晨",
      "例外",
    ]);
  });
  it("提醒只含今天与逾期未完成，按原 due_at 筛选；置顶正文仅取渲染后的前两行", async () => {
    const { api, data, clock } = await setup();
    const { start, end } = localDayRange(clock.now);
    await data.reminders.create({ title: "逾期", due_at: start - 1 });
    await data.reminders.create({ title: "今天", due_at: end - 1, snooze_until: end + 60_000 });
    await data.reminders.create({ title: "明日", due_at: end });
    await data.reminders.create({ title: "无时间" });
    await data.reminders.create({ title: "完成", due_at: start, completed_at: clock.now });
    const deleted = await data.reminders.create({ title: "删除", due_at: start });
    await data.reminders.softDelete(deleted.id);
    const memo = await data.memos.create({
      title: "重点",
      content: "## **第一行**\n\n第二行\n\n第三行",
      pinned: true,
    });
    await data.memos.create({ title: "普通", pinned: false });
    const gone = await data.memos.create({ title: "删除置顶", pinned: true });
    await data.memos.softDelete(gone.id);
    const today = await api.loadToday();
    expect(today.reminders.map((row) => row.title)).toEqual(["逾期", "今天"]);
    expect(today.memos).toEqual([
      expect.objectContaining({ id: memo.id, preview: "第一行\n第二行" }),
    ]);
  });
  it("空数据库仍返回三个空区块；午夜后数据范围切换", async () => {
    const { api, data, clock } = await setup();
    expect(await api.loadToday()).toEqual({ events: [], reminders: [], memos: [] });
    const boundary = localDayRange(clock.now).end;
    await data.reminders.create({ title: "明天开始", due_at: boundary });
    expect((await api.loadToday()).reminders).toEqual([]);
    clock.now = boundary;
    expect((await api.loadToday()).reminders[0]?.title).toBe("明天开始");
  });
  it("旧卡片与到点触发竞态时只完成旧实例，不误完成已经推进的下一次", async () => {
    const { api, data, clock } = await setup();
    const due = clock.now + 1000;
    const parent = await data.reminders.create({
      title: "每天",
      due_at: due,
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const old = (await api.loadToday()).reminders[0]!;
    expect(old.occurrenceId).toBeNull();
    const row = await data.occurrences.ensure(parent, due);
    clock.now = due;
    await data.occurrences.claim(row, parent, due + 86_400_000);
    await api.completeReminderItem(old);
    expect((await data.occurrences.get(row.id))?.completed_at).toBe(due);
    expect(await data.reminders.get(parent.id)).toMatchObject({
      due_at: due + 86_400_000,
      completed_at: null,
    });
    await data.reminders.update(parent.id, { due_at: due + 90_000 });
    await expect(api.completeReminderItem(old)).rejects.toThrow("时间已改变");
  });
});
describe("日期监听", () => {
  it("午夜精确定时只刷新一次，睡眠跨天恢复和清理监听均正确", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 5, 23, 59, 59));
    const changed = vi.fn();
    const pulse = vi.fn();
    const watch = watchToday(changed, pulse, {
      now: () => Date.now(),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    await vi.advanceTimersByTimeAsync(1005);
    expect(changed).toHaveBeenCalledOnce();
    watch.check();
    expect(changed).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date(2026, 10, 8, 10));
    watch.check();
    expect(changed).toHaveBeenCalledTimes(2);
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("本地日期区间按自然日计算，覆盖夏令时的 23/25 小时日", () => {
    vi.stubEnv("TZ", "America/New_York");
    const spring = localDayRange(new Date(2026, 2, 8, 12).getTime());
    const autumn = localDayRange(new Date(2026, 10, 1, 12).getTime());
    expect(spring.end - spring.start).toBe(23 * 3_600_000);
    expect(autumn.end - autumn.start).toBe(25 * 3_600_000);
  });
});
