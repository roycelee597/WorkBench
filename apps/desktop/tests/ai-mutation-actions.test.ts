import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, type MemoryDatabase } from "./memory-database";
import { createGeneralApi } from "../../../workbenches/general/src/api";
import { createAiMutationActions } from "../../../workbenches/general/src/ai-mutation-actions";
import {
  aiDeleteDestination,
  aiMutationDiff,
  type AiMutationDraft,
} from "../../../workbenches/general/src/ai-mutation-model";
import { MemoryRefTable } from "../src/core/ai/ref-table";
import { AiRegistry } from "../src/core/ai/registry";
import type { AiContext, Prepared, SeriesScope } from "../src/core/ai/action-types";
import type { CalendarEvent, Reminder } from "../src/core/repositories/models";

const databases: MemoryDatabase[] = [];
const at = (day: number, hour = 15) => Date.UTC(2026, 10, day, hour - 8);
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
async function setup() {
  const f = await fixture();
  databases.push(f.db);
  f.clock.now = at(18, 12);
  const api = createGeneralApi(async () => f.data, {
    now: () => f.clock.now,
    offerAutostart: vi.fn(),
  });
  const actions = createAiMutationActions(api);
  const refs = new MemoryRefTable({ now: () => f.clock.now });
  const ctx: AiContext = { now: f.clock.now, timezone: "Asia/Shanghai", refs };
  async function event(patch: Partial<CalendarEvent> = {}) {
    return f.data.events.create({
      title: "本地日程",
      start_at: at(20),
      end_at: at(20, 16),
      timezone: "Asia/Shanghai",
      ...patch,
    });
  }
  async function eventRef(
    row: CalendarEvent,
    originalStart: number | null = row.rrule ? row.start_at : null,
  ) {
    const state = await api.aiEventState(row.id, originalStart);
    return refs.issue(
      { kind: "event", eventId: row.id, originalStart },
      {
        updatedAt: state.series.updated_at,
        ...(state.related.length ? { related: state.related } : {}),
      },
    );
  }
  async function reminder(patch: Partial<Reminder> = {}) {
    return f.data.reminders.create({
      title: "本地提醒",
      due_at: at(20),
      timezone: "Asia/Shanghai",
      ...patch,
    });
  }
  function reminderRef(row: Reminder) {
    return refs.issue(
      { kind: "reminder", reminderId: row.id, occurrenceId: null },
      { updatedAt: row.updated_at },
    );
  }
  const action = (name: string) => {
    const value = actions.find((item) => item.name === name);
    if (!value) throw new Error(name);
    return value;
  };
  async function proposal(name: string, value: unknown) {
    const a = action(name);
    const result: Prepared<AiMutationDraft> = await a.prepare(value, ctx);
    expect(result.type).toBe("proposal");
    if (result.type !== "proposal") throw new Error(JSON.stringify(result));
    return { action: a, draft: result.draft, prepared: result };
  }
  return {
    ...f,
    api,
    actions,
    refs,
    ctx,
    event,
    eventRef,
    reminder,
    reminderRef,
    action,
    proposal,
  };
}

describe("AI 修改与删除的本地目标边界", () => {
  it("四个操作都是依赖读取的严格写入工具，prepare 不执行，修改只存编辑后的值", async () => {
    const f = await setup();
    const registry = new AiRegistry();
    registry.register({
      workbenchId: "com.royce.workbench.general",
      label: "修改删除",
      actions: f.actions,
    });
    expect(f.actions).toHaveLength(4);
    expect(f.actions.every((action) => action.kind === "write" && action.requiresRead)).toBe(true);
    expect(registry.tools()).toHaveLength(4);
    const row = await f.event();
    const ref = await f.eventRef(row);
    const p = await f.proposal("calendar_update_event", {
      refs: [ref],
      changes: { start: "2026-11-20T16:00" },
    });
    expect((await f.data.events.get(row.id))?.start_at).toBe(at(20));
    expect(aiMutationDiff(p.draft).map((row) => row.field)).toEqual(["start", "end"]);
    if (p.draft.next?.type !== "event") throw new Error("缺少日程草稿");
    p.draft.next.form.title = "用户编辑后的标题";
    expect(p.action.validate!(p.draft)).toEqual([]);
    await p.action.execute!(p.draft);
    expect(await f.data.events.get(row.id)).toMatchObject({
      title: "用户编辑后的标题",
      start_at: at(20, 16),
      end_at: at(20, 17),
    });
    expect((await f.api.eventTarget(row.id)).event.title).toBe("用户编辑后的标题");
    expect(p.action.args.safeParse({ refs: [ref], changes: { id: "伪造id" } }).success).toBe(false);
  });

  it("全部ref先校验，未知、类型不符、过期或已删除均不产生部分卡片", async () => {
    const f = await setup();
    const row = await f.event();
    const ref = await f.eventRef(row);
    const a = f.action("calendar_delete_event");
    expect(await a.prepare({ refs: [ref, "e999"], mode: "all_listed" }, f.ctx)).toMatchObject({
      type: "error",
      message: "AI 指向了不存在的项目，请重新说一次",
    });
    const reminder = await f.reminder();
    expect(
      await a.prepare({ refs: [f.reminderRef(reminder)], mode: "pick_one" }, f.ctx),
    ).toMatchObject({ type: "error", message: expect.stringContaining("不存在") });
    await f.data.events.softDelete(row.id);
    expect(await a.prepare({ refs: [ref], mode: "pick_one" }, f.ctx)).toMatchObject({
      type: "error",
      message: "这条已经不存在了",
    });
    const another = await f.event();
    const expired = await f.eventRef(another);
    f.clock.now += 30 * 60 * 1000;
    expect(await a.prepare({ refs: [expired], mode: "pick_one" }, f.ctx)).toMatchObject({
      type: "error",
      message: expect.stringContaining("不存在"),
    });
  });

  it("日程换结束时间最多七天，卡片编辑同样校验，原有长日程可换标题", async () => {
    const f = await setup();
    const row = await f.event();
    const ref = await f.eventRef(row);
    const invalid = { refs: [ref], changes: { end: "2026-11-27T15:01" } };
    expect(await f.action("calendar_update_event").prepare(invalid, f.ctx)).toMatchObject({
      type: "error",
      message: "日程最长 7 天",
    });

    const { action, draft } = await f.proposal("calendar_update_event", {
      refs: [ref],
      changes: { end: "2026-11-27T15:00" },
    });
    if (draft.next?.type !== "event") throw new Error("缺少日程草稿");
    draft.next.form.end = invalid.changes.end;
    expect(action.validate!(draft)).toEqual(["日程最长 7 天"]);
    await expect(action.execute!(draft)).rejects.toThrow("日程最长 7 天");
    expect((await f.data.events.get(row.id))?.end_at).toBe(at(20, 16));
    draft.next.form.end = "2026-11-27T15:00";
    await action.execute!(draft);
    expect((await f.data.events.get(row.id))?.end_at).toBe(at(27));

    const long = await f.event({ end_at: at(28) });
    const titleOnly = await f.proposal("calendar_update_event", {
      refs: [await f.eventRef(long)],
      changes: { title: "原有长日程换标题" },
    });
    await titleOnly.action.execute!(titleOnly.draft);
    expect(await f.data.events.get(long.id)).toMatchObject({
      title: "原有长日程换标题",
      end_at: at(28),
    });
  });

  it("多个目标只出候选，本地标题/时间不可用模型替换，超过10个拒绝", async () => {
    const f = await setup();
    const refs: string[] = [];
    for (let i = 0; i < 11; i++)
      refs.push(await f.eventRef(await f.event({ title: `真实标题${i}` })));
    const a = f.action("calendar_update_event");
    const chosen = await a.prepare({ refs: refs.slice(0, 2), changes: { title: "新标题" } }, f.ctx);
    expect(chosen.type).toBe("choose");
    if (chosen.type !== "choose") throw new Error("缺少候选");
    expect(chosen.candidates.map((item) => item.title)).toEqual(["真实标题0", "真实标题1"]);
    expect(await chosen.pick("e999")).toMatchObject({ type: "error" });
    expect(await chosen.pick(refs[1]!)).toMatchObject({
      type: "proposal",
      draft: { items: [{ title: "真实标题1" }] },
    });
    expect(await a.prepare({ refs, changes: { title: "新标题" } }, f.ctx)).toMatchObject({
      type: "error",
      message: expect.stringContaining("太多"),
    });
    expect(
      await f.action("calendar_delete_event").prepare({ refs, mode: "pick_one" }, f.ctx),
    ).toMatchObject({ type: "error", message: expect.stringContaining("太多") });
  });

  it("拒绝整组中的日程生成/金融提醒，日程生成错误带本地跳转目标", async () => {
    const f = await setup();
    const event = await f.event({ remind_before_minutes: 30 });
    const generated = (await f.data.reminders.list()).find((row) => row.event_id === event.id)!;
    const normal = await f.reminder();
    const finance = await f.reminder({ source_workbench: "com.royce.workbench.finance" });
    for (const name of ["reminders_update", "reminders_delete"]) {
      const action = f.action(name);
      const body = name.endsWith("update")
        ? { changes: { title: "禁止" } }
        : { mode: "all_listed" };
      expect(
        await action.prepare(
          { refs: [f.reminderRef(normal), f.reminderRef(generated)], ...body },
          f.ctx,
        ),
      ).toMatchObject({
        type: "error",
        target: { kind: "event", eventId: event.id },
        message: expect.stringContaining("日程生成"),
      });
      expect(
        await action.prepare({ refs: [f.reminderRef(finance)], ...body }, f.ctx),
      ).toMatchObject({ type: "error", message: expect.stringContaining("金融") });
    }
    expect(await f.data.reminders.get(normal.id)).not.toBeNull();
  });

  it("重复提醒修改明确整个规则，取消到期时间同时取消重复", async () => {
    const f = await setup();
    const row = await f.reminder({ rrule: "FREQ=DAILY;COUNT=5" });
    const p = await f.proposal("reminders_update", {
      refs: [f.reminderRef(row)],
      changes: { due: null, priority: 3 },
    });
    expect(p.prepared.note).toContain("整个重复提醒");
    expect(p.prepared.needsScope).toBe(false);
    await p.action.execute!(p.draft);
    expect(await f.data.reminders.get(row.id)).toMatchObject({
      due_at: null,
      rrule: null,
      priority: 3,
    });
  });
});

describe("AI 重复日程和批量删除复用", () => {
  it.each<SeriesScope>(["this", "following", "all"])(
    "修改范围 %s 走现有拆分逻辑且结果仍可定位",
    async (scope) => {
      const f = await setup();
      const row = await f.event({ rrule: "FREQ=DAILY;COUNT=5" });
      const p = await f.proposal("calendar_update_event", {
        refs: [await f.eventRef(row, at(22))],
        changes: { title: "改后系列", start: "2026-11-22T16:00" },
      });
      expect(p.prepared.needsScope).toBe(true);
      await expect(p.action.execute!(p.draft)).rejects.toThrow("范围");
      const result = await p.action.execute!(p.draft, scope);
      expect(result.target?.kind).toBe("event");
      if (result.target?.kind !== "event") throw new Error("缺少跳转目标");
      const target = await f.api.eventTarget(result.target.eventId, result.target.originalStart);
      expect(target.event.title).toBe("改后系列");
      if (scope === "this") expect((await f.data.events.get(row.id))?.title).toBe("本地日程");
      if (scope === "following")
        expect(
          (await f.data.events.list()).some(
            (item) => item.id !== row.id && item.recurrence_id === null,
          ),
        ).toBe(true);
      if (scope === "all") expect((await f.data.events.get(row.id))?.title).toBe("改后系列");
    },
  );

  it.each<SeriesScope>(["this", "following", "all"])(
    "删除范围 %s 的回收站说明与实际一致",
    async (scope) => {
      const f = await setup();
      const row = await f.event({ rrule: "FREQ=DAILY;COUNT=5", remind_before_minutes: 30 });
      const p = await f.proposal("calendar_delete_event", {
        refs: [await f.eventRef(row, at(22))],
        mode: "pick_one",
      });
      const note = aiDeleteDestination(p.draft, scope).join("");
      if (scope === "all") expect(note).toContain("整个系列");
      else expect(note).toContain("不进回收站");
      await p.action.execute!(p.draft, scope);
      if (scope === "all") {
        expect(await f.data.events.get(row.id)).toBeNull();
        expect(await f.data.events.listDeleted()).toHaveLength(1);
        expect(await f.data.reminders.listDeleted()).toHaveLength(1);
      } else {
        expect(await f.data.events.listDeleted()).toHaveLength(0);
        const state = await f.data.events.get(row.id);
        if (scope === "this") expect(state?.exdates).toContain(at(22));
        else expect(state?.rrule).toContain("UNTIL=");
      }
    },
  );

  it("首个实例选following确实删除整个系列；已有例外的关联提醒随实际规则软删除", async () => {
    const f = await setup();
    const row = await f.event({ rrule: "FREQ=DAILY;COUNT=5", remind_before_minutes: 30 });
    await f.data.events.editOccurrence(row.id, at(22), "this", { title: "例外" });
    const current = (await f.data.events.get(row.id))!;
    const p = await f.proposal("calendar_delete_event", {
      refs: [await f.eventRef(current, at(20))],
      mode: "pick_one",
    });
    expect(aiDeleteDestination(p.draft, "following").join("")).toContain("整个系列");
    await p.action.execute!(p.draft, "following");
    expect(await f.data.events.list()).toEqual([]);
    expect(await f.data.events.listDeleted()).toHaveLength(2);
    expect(await f.data.reminders.list()).toEqual([]);
  });

  it("批量取消勾选后可重新勾选，只删除最终选中项；同系列多个this不误报自己的并发", async () => {
    const f = await setup();
    const first = await f.event(),
      second = await f.event();
    const a = await f.eventRef(first),
      b = await f.eventRef(second);
    const p = await f.proposal("calendar_delete_event", { refs: [a, b], mode: "all_listed" });
    expect(p.prepared.selections).toHaveLength(2);
    p.draft = p.action.select!(p.draft, [a]);
    p.draft = p.action.select!(p.draft, [a, b]);
    p.draft = p.action.select!(p.draft, [b]);
    await p.action.execute!(p.draft);
    expect(await f.data.events.get(first.id)).not.toBeNull();
    expect(await f.data.events.get(second.id)).toBeNull();
    const series = await f.event({ rrule: "FREQ=DAILY;COUNT=5" });
    const one = await f.eventRef(series, at(21)),
      two = await f.eventRef(series, at(22));
    const group = await f.proposal("calendar_delete_event", {
      refs: [one, two],
      mode: "all_listed",
    });
    f.clock.now++;
    await group.action.execute!(group.draft, "this");
    expect((await f.data.events.get(series.id))?.exdates).toEqual([at(21), at(22)]);
  });
});

describe("AI 确认后的并发保护", () => {
  it("批量第二项失败时显示成功进度，重试只写剩余项并锁定原选择", async () => {
    const f = await setup();
    const first = await f.event(),
      second = await f.event();
    const p = await f.proposal("calendar_delete_event", {
      refs: [await f.eventRef(first), await f.eventRef(second)],
      mode: "all_listed",
    });
    const original = f.api.deleteEvent.bind(f.api);
    let failed = false;
    const writes = vi.spyOn(f.api, "deleteEvent").mockImplementation(async (id, expected) => {
      if (id === second.id && !failed) {
        failed = true;
        throw new Error("模拟第二项暂时不可写");
      }
      return original(id, expected);
    });
    await expect(p.action.execute!(p.draft)).rejects.toThrow("已完成删除 1/2 项");
    expect(await f.data.events.get(first.id)).toBeNull();
    expect(await f.data.events.get(second.id)).not.toBeNull();
    expect(p.action.validate!(p.action.select!(p.draft, [p.draft.selectedIds[1]!]))[0]).toContain(
      "保持原选择",
    );
    await p.action.execute!(p.draft);
    expect(writes.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
    expect(writes.mock.calls.filter(([id]) => id === second.id)).toHaveLength(2);
    expect(await f.data.events.listDeleted()).toHaveLength(2);
    expect(p.action.validate!(p.draft)).not.toEqual([]);
  });

  it("同系列多个this中断后保留自己生成的父快照，范围改变拒绝，原范围可续作", async () => {
    const f = await setup();
    const row = await f.event({ rrule: "FREQ=DAILY;COUNT=5" });
    const p = await f.proposal("calendar_delete_event", {
      refs: [await f.eventRef(row, at(21)), await f.eventRef(row, at(22))],
      mode: "all_listed",
    });
    const original = f.api.deleteEventOccurrenceChecked.bind(f.api);
    let failed = false;
    const writes = vi
      .spyOn(f.api, "deleteEventOccurrenceChecked")
      .mockImplementation(async (id, start, scope, expected) => {
        if (start === at(22) && !failed) {
          failed = true;
          throw new Error("模拟第二实例暂时不可写");
        }
        return original(id, start, scope, expected);
      });
    f.clock.now++;
    await expect(p.action.execute!(p.draft, "this")).rejects.toThrow("已完成删除 1/2 项");
    await expect(p.action.execute!(p.draft, "all")).rejects.toThrow("保持原范围");
    await p.action.execute!(p.draft, "this");
    expect((await f.data.events.get(row.id))?.exdates).toEqual([at(21), at(22)]);
    expect(writes.mock.calls.filter(([, start]) => start === at(21))).toHaveLength(1);
    expect(await f.data.events.listDeleted()).toHaveLength(0);
  });

  it("批量提醒重试跳过已成功软删除的父提醒", async () => {
    const f = await setup();
    const first = await f.reminder(),
      second = await f.reminder();
    const p = await f.proposal("reminders_delete", {
      refs: [f.reminderRef(first), f.reminderRef(second)],
      mode: "all_listed",
    });
    const original = f.api.deleteReminder.bind(f.api);
    let failed = false;
    const writes = vi.spyOn(f.api, "deleteReminder").mockImplementation(async (id, expected) => {
      if (id === second.id && !failed) {
        failed = true;
        throw new Error("模拟提醒写入失败");
      }
      return original(id, expected);
    });
    await expect(p.action.execute!(p.draft)).rejects.toThrow("重试只处理剩余项目");
    await p.action.execute!(p.draft);
    expect(writes.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
    expect(await f.data.reminders.listDeleted()).toHaveLength(2);
  });

  it("新提案清理全部refs已过期的计划，成功完成的计划立即释放", async () => {
    const f = await setup();
    const old = await f.event();
    const expired = await f.proposal("calendar_update_event", {
      refs: [await f.eventRef(old)],
      changes: { title: "过期草稿" },
    });
    f.clock.now += 30 * 60 * 1000;
    const fresh = await f.event();
    const current = await f.proposal("calendar_update_event", {
      refs: [await f.eventRef(fresh)],
      changes: { title: "新草稿" },
    });
    expect(expired.action.validate!(expired.draft)).not.toEqual([]);
    await current.action.execute!(current.draft);
    expect(current.action.validate!(current.draft)).not.toEqual([]);
  });

  it("确认前重查全部目标，一项发生改变则整组零写入；清空refs也拒绝", async () => {
    const f = await setup();
    const first = await f.event(),
      second = await f.event();
    const p = await f.proposal("calendar_delete_event", {
      refs: [await f.eventRef(first), await f.eventRef(second)],
      mode: "all_listed",
    });
    f.clock.now++;
    await f.data.events.update(second.id, { title: "别处改过" });
    await expect(p.action.execute!(p.draft)).rejects.toThrow("内容已变化");
    expect(await f.data.events.listDeleted()).toEqual([]);
    const q = await f.proposal("calendar_update_event", {
      refs: [await f.eventRef(first)],
      changes: { title: "新标题" },
    });
    f.refs.clear();
    await expect(q.action.execute!(q.draft)).rejects.toThrow("不存在的项目");
  });

  it("有效例外版本与父版本分别校验，移动例外仍能按originalStart或例外id定位", async () => {
    const f = await setup();
    const row = await f.event({ rrule: "FREQ=DAILY;COUNT=5" });
    await f.data.events.editOccurrence(row.id, at(22), "this", {
      start_at: at(25),
      end_at: at(25, 16),
      title: "移后的例外",
    });
    const current = (await f.data.events.get(row.id))!;
    const state = await f.api.aiEventState(row.id, at(22));
    const exception = state.occurrence.event;
    expect((await f.api.eventTarget(row.id, at(22))).start_at).toBe(at(25));
    expect((await f.api.eventTarget(exception.id)).start_at).toBe(at(25));
    const ref = await f.eventRef(current, at(22));
    f.clock.now++;
    await f.data.events.update(exception.id, { notes: "别处只修改例外" });
    expect((await f.data.events.get(row.id))?.updated_at).toBe(current.updated_at);
    expect(
      await f.action("calendar_delete_event").prepare({ refs: [ref], mode: "pick_one" }, f.ctx),
    ).toMatchObject({ type: "error", message: "内容已变化，请重新说一次" });
  });

  it.each(["event", "reminder"] as const)(
    "%s在execute读完后又改变，数据库原子expected阻止覆盖",
    async (kind) => {
      const f = await setup();
      const row = kind === "event" ? await f.event() : await f.reminder();
      const ref =
        kind === "event" ? await f.eventRef(row as CalendarEvent) : f.reminderRef(row as Reminder);
      const p = await f.proposal(kind === "event" ? "calendar_update_event" : "reminders_update", {
        refs: [ref],
        changes: { title: "不应覆盖" },
      });
      const batch = f.db.batch.bind(f.db);
      vi.spyOn(f.db, "batch").mockImplementationOnce(async (statements) => {
        f.db.connection
          .prepare(
            `UPDATE ${kind === "event" ? "events" : "reminders"} SET updated_at = updated_at + 1, title = '并发的新值' WHERE id = ?`,
          )
          .run(row.id);
        return batch(statements);
      });
      await expect(p.action.execute!(p.draft)).rejects.toThrow("内容已变化");
      expect(
        (kind === "event" ? await f.data.events.get(row.id) : await f.data.reminders.get(row.id))
          ?.title,
      ).toBe("并发的新值");
    },
  );

  it("禁止篡改本地目标/原值/选中项，操作类型不匹配和空差异也拒绝", async () => {
    const f = await setup();
    const row = await f.event();
    const ref = await f.eventRef(row);
    const p = await f.proposal("calendar_update_event", {
      refs: [ref],
      changes: { title: "新标题" },
    });
    expect(p.action.validate!({ ...p.draft, selectedIds: ["e999"] })).not.toEqual([]);
    const changed = structuredClone(p.draft);
    changed.items[0]!.title = "伪造";
    expect(p.action.validate!(changed)).not.toEqual([]);
    expect(f.action("calendar_delete_event").validate!(p.draft)).not.toEqual([]);
    expect(
      await p.action.prepare({ refs: [ref], changes: { title: row.title } }, f.ctx),
    ).toMatchObject({ type: "error", message: "没有需要修改的字段" });
    expect(
      f.action("calendar_delete_event").args.safeParse({
        refs: Array.from({ length: 21 }, (_, i) => `e${i + 1}`),
        mode: "all_listed",
      }).success,
    ).toBe(false);
  });
});
