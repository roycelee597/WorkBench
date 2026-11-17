import { afterEach, describe, expect, it, vi } from "vitest";
import { RRule } from "rrule";
import { createGeneralAiActions } from "../../../workbenches/general/src/ai-actions";
import {
  aiCreateSummary,
  aiRepeatDraft,
  parseAiCreateDraft,
  validateAiCreateDraft,
  type AiCreateDraft,
  type AiRepeat,
} from "../../../workbenches/general/src/ai-create-model";
import { createGeneralApi } from "../../../workbenches/general/src/api";
import { draftFields, buildRule } from "../../../workbenches/general/src/calendar-model";
import { reminderFields } from "../../../workbenches/general/src/reminder-model";
import { AiOrchestrator } from "../src/core/ai/orchestrator";
import { AiRegistry } from "../src/core/ai/registry";
import { MemoryRefTable } from "../src/core/ai/ref-table";
import { llmRequestSchema } from "../src/core/ai/llm-client";
import { parseLocalTime } from "../src/core/ai/local-time";
import { parseRule } from "../src/core/calendar/recurrence";
import { fixture, type MemoryDatabase } from "./memory-database";
import { MockLlmClient } from "./mock-llm-client";

const databases: MemoryDatabase[] = [];
const now = Date.parse("2026-11-16T04:00:00Z");
const zone = "Asia/Shanghai";
const source = "com.royce.workbench.ai";
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
async function setup() {
  const value = await fixture();
  databases.push(value.db);
  value.clock.now = now;
  const api = createGeneralApi(async () => value.data, { now: () => now, offerAutostart: vi.fn() });
  const group = createGeneralAiActions(api);
  const registry = new AiRegistry();
  registry.register(group);
  const refs = new MemoryRefTable({ now: () => now });
  const ctx = { now, timezone: zone, refs };
  async function proposal(name: string, args: unknown) {
    const action = registry.get(name)!;
    const prepared = await action.prepare(args, ctx);
    expect(prepared.type).toBe("proposal");
    if (prepared.type !== "proposal") throw new Error("测试预期得到提案");
    return { action, draft: parseAiCreateDraft(prepared.draft), prepared };
  }
  return { ...value, api, group, registry, refs, ctx, proposal };
}
async function assertEmpty(data: Awaited<ReturnType<typeof fixture>>["data"]) {
  expect(await data.events.list()).toEqual([]);
  expect(await data.reminders.list()).toEqual([]);
  expect(await data.memos.list()).toEqual([]);
}

describe("综合工作台 AI 新建操作", () => {
  it("只登记三个严格写入工具，MockLlmClient 编排只生成卡片、不碰引用或写库", async () => {
    const { registry, refs, data } = await setup();
    const issue = vi.spyOn(refs, "issue");
    const resolve = vi.spyOn(refs, "resolve");
    const client = new MockLlmClient([
      {
        content: null,
        tool_calls: [
          {
            id: "event",
            name: "calendar_create_event",
            arguments: JSON.stringify({ title: "组会", start: "2026-11-18T15:00" }),
          },
          {
            id: "reminder",
            name: "reminders_create",
            arguments: JSON.stringify({ title: "交作业", due: "2026-11-19T18:00" }),
          },
          {
            id: "memo",
            name: "memos_create",
            arguments: JSON.stringify({ content: "记住本周读书计划" }),
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);
    const orchestrator = new AiOrchestrator({
      client,
      registry,
      refs,
      now: () => now,
      timezone: () => zone,
    });
    const result = await orchestrator.run({ text: "建一个组会、交作业提醒，并记下读书计划" });
    expect(result.events.filter((event) => event.type === "prepared")).toHaveLength(3);
    expect(client.requests).toHaveLength(1);
    expect(llmRequestSchema.safeParse(client.requests[0]).success).toBe(true);
    expect(registry.tools()).toHaveLength(3);
    for (const tool of registry.tools()) {
      expect(tool.function.parameters.additionalProperties).toBe(false);
      expect(tool.function.parameters.properties).not.toHaveProperty("refs");
      expect(tool.function.parameters.properties).not.toHaveProperty("rrule");
      expect(registry.get(tool.function.name)?.kind).toBe("write");
    }
    expect(issue).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    await assertEmpty(data);
  });

  it("日程确认后才写入，支持编辑后的字段、重复规则、提前提醒联动和 AI 来源", async () => {
    const { data, proposal } = await setup();
    const { action, draft, prepared } = await proposal("calendar_create_event", {
      title: "  组会  ",
      notes: "带电脑",
      start: "2026-11-18T15:00",
      duration_minutes: 90,
      remind_before_minutes: 20,
      repeat: { preset: "weekly", weekdays: [2, 4], end: { type: "count", count: 5 } },
    });
    expect(draft.type).toBe("event");
    if (draft.type !== "event") throw new Error("测试类型错误");
    expect(draft.form).toMatchObject({
      title: "组会",
      end: "2026-11-18T16:30",
      reminder: 15,
      repeat: { weekdays: [1, 3], end: "count", count: "5" },
    });
    expect(prepared.note).toContain("20 分钟调整为 15 分钟");
    await assertEmpty(data);
    draft.form.title = "改成讨论课";
    expect(action.validate?.(draft)).toEqual([]);
    const saved = await action.execute!(draft);
    const row = (await data.events.list())[0]!;
    expect(row).toMatchObject({
      title: "改成讨论课",
      notes: "带电脑",
      start_at: parseLocalTime("2026-11-18T15:00", zone),
      end_at: parseLocalTime("2026-11-18T16:30", zone),
      timezone: zone,
      source_workbench: source,
      remind_before_minutes: 15,
    });
    expect(row.rrule).toContain("BYDAY=TU,TH");
    expect(row.rrule).toContain("COUNT=5");
    expect(saved.target).toEqual({ kind: "event", eventId: row.id, originalStart: null });
    expect((await data.reminders.list())[0]).toMatchObject({
      event_id: row.id,
      source: "event",
      due_at: row.start_at - 15 * 60_000,
    });
    expect(await data.settings.getValue("autostart_prompted")).toBe(true);
  });

  it("默认时长、默认提醒和全天日期适配现有含结束当天的表单", async () => {
    const { data, proposal } = await setup();
    await data.settings.setValue("default_event_remind", 30);
    const timed = await proposal("calendar_create_event", {
      title: "一小时",
      start: "2026-11-18T15:00",
    });
    expect(timed.draft).toMatchObject({
      type: "event",
      form: { end: "2026-11-18T16:00", reminder: 30 },
    });
    const allDay = await proposal("calendar_create_event", {
      title: "全天",
      start: "2026-11-18",
      all_day: true,
    });
    expect(allDay.draft).toMatchObject({
      type: "event",
      form: { start: "2026-11-18", end: "2026-11-18", allDay: true },
    });
    if (allDay.draft.type !== "event") throw new Error("测试类型错误");
    expect(draftFields(allDay.draft.form)).toMatchObject({
      start_at: parseLocalTime("2026-11-18", zone),
      end_at: parseLocalTime("2026-11-19", zone),
    });
    const explicit = await proposal("calendar_create_event", {
      title: "两天",
      start: "2026-11-18",
      end: "2026-11-20",
      all_day: true,
    });
    expect(explicit.draft).toMatchObject({ type: "event", form: { end: "2026-11-19" } });
    const noReminder = await proposal("calendar_create_event", {
      title: "不提醒",
      start: "2026-11-18T15:00",
      remind_before_minutes: null,
    });
    expect(noReminder.draft).toMatchObject({ form: { reminder: null } });
  });

  it("提醒支持指定时间/无时间待办，写入来源manual并沿用自启提示", async () => {
    const { data, proposal } = await setup();
    const first = await proposal("reminders_create", {
      title: "交作业",
      notes: "在线提交",
      due: "2026-11-19T18:00",
      priority: 3,
      repeat: { preset: "daily", end: { type: "count", count: 2 } },
    });
    await assertEmpty(data);
    const result = await first.action.execute!(first.draft);
    const row = (await data.reminders.list())[0]!;
    expect(row).toMatchObject({
      title: "交作业",
      notes: "在线提交",
      due_at: parseLocalTime("2026-11-19T18:00", zone),
      priority: 3,
      rrule: "FREQ=DAILY;COUNT=2",
      source_workbench: source,
      source: "manual",
      timezone: zone,
    });
    expect(result.target).toEqual({ kind: "reminder", reminderId: row.id, occurrenceId: null });
    const task = await proposal("reminders_create", { title: "读书", due: null });
    await task.action.execute!(task.draft);
    expect((await data.reminders.list()).find((item) => item.title === "读书")).toMatchObject({
      due_at: null,
      rrule: null,
      priority: 0,
      source: "manual",
      source_workbench: source,
    });
  });

  it("备忘录一次写入标题正文和规范标签，不走空白创建后再更新", async () => {
    const { data, proposal } = await setup();
    const create = vi.spyOn(data.memos, "create");
    const update = vi.spyOn(data.memos, "update");
    const { action, draft } = await proposal("memos_create", {
      title: "  读书  ",
      content: "读完第三章\n记录要点",
      tags: [" 学习 ", "学习", "TS", "ts", ""],
    });
    expect(draft).toMatchObject({
      type: "memo",
      form: { title: "读书", tags: ["学习", "TS"], pinned: false },
    });
    await assertEmpty(data);
    expect(create).not.toHaveBeenCalled();
    const result = await action.execute!(draft);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      title: "读书",
      content: "读完第三章\n记录要点",
      tags: ["学习", "TS"],
      pinned: false,
    });
    expect(update).not.toHaveBeenCalled();
    const row = (await data.memos.list())[0]!;
    expect(result.target).toEqual({ kind: "memo", memoId: row.id });
    expect(row).toMatchObject({
      created_at: now,
      updated_at: now,
      deleted_at: null,
      tags: ["学习", "TS"],
    });
    expect(row).not.toHaveProperty("source_workbench");
  });

  it("过去时间只提示核对，不擅自更改为未来", async () => {
    const { proposal } = await setup();
    for (const [name, args] of [
      ["calendar_create_event", { title: "过去日程", start: "2026-11-15T10:00" }],
      ["reminders_create", { title: "过去提醒", due: "2026-11-15T10:00" }],
    ] as const) {
      const { prepared } = await proposal(name, args);
      expect(prepared.note).toContain("时间已在过去");
    }
  });

  it.each([
    ["calendar_create_event", { title: "日期", start: "2026-02-30T10:00" }],
    ["calendar_create_event", { title: "时区偏移", start: "2026-11-18T10:00Z" }],
    [
      "calendar_create_event",
      { title: "倒序", start: "2026-11-18T10:00", end: "2026-11-18T09:00" },
    ],
    [
      "calendar_create_event",
      { title: "零时长", start: "2026-11-18T10:00", end: "2026-11-18T10:00" },
    ],
    [
      "calendar_create_event",
      { title: "全天零时长", start: "2026-11-18", end: "2026-11-18", all_day: true },
    ],
    [
      "calendar_create_event",
      { title: "不能直接规则", start: "2026-11-18T10:00", rrule: "FREQ=DAILY" },
    ],
    ["calendar_create_event", { title: "不能引用", start: "2026-11-18T10:00", refs: ["e1"] }],
    [
      "calendar_create_event",
      { title: "星期", start: "2026-11-18T10:00", repeat: { preset: "weekly", weekdays: [8] } },
    ],
    [
      "calendar_create_event",
      {
        title: "多余重复字段",
        start: "2026-11-18T10:00",
        repeat: { preset: "daily", weekdays: [1] },
      },
    ],
    [
      "calendar_create_event",
      {
        title: "非法截止日",
        start: "2026-11-18T10:00",
        repeat: { preset: "daily", end: { type: "until", until: "2027-02-30" } },
      },
    ],
    [
      "calendar_create_event",
      {
        title: "截止早于开始",
        start: "2026-11-18T10:00",
        repeat: { preset: "daily", end: { type: "until", until: "2026-11-17" } },
      },
    ],
    [
      "calendar_create_event",
      {
        title: "次数",
        start: "2026-11-18T10:00",
        repeat: { preset: "daily", end: { type: "count", count: 1000 } },
      },
    ],
    ["reminders_create", { title: "没有时间的重复", due: null, repeat: { preset: "daily" } }],
    ["reminders_create", { title: "优先级", due: null, priority: 4 }],
    ["reminders_create", { title: "多余字段", due: null, source: "event" }],
    ["memos_create", { content: "正文", tags: [1] }],
    ["memos_create", { content: "   " }],
  ])("非法模型参数不生成卡片或写库：%s %#", async (name, args) => {
    const { registry, ctx, data } = await setup();
    const result = await registry.get(name)!.prepare(args, ctx);
    expect(result.type).toBe("error");
    await assertEmpty(data);
  });

  it("确认前重新校验编辑草稿，拒绝额外字段、错误类型和非法日期；隐藏重复遵循现有提醒表单", async () => {
    const { proposal, data } = await setup();
    const event = await proposal("calendar_create_event", {
      title: "组会",
      start: "2026-11-18T15:00",
    });
    const invalid = structuredClone(event.draft);
    if (invalid.type !== "event") throw new Error("测试类型错误");
    invalid.form.start = "2026-02-30T15:00";
    expect(event.action.validate?.(invalid)).not.toEqual([]);
    await expect(event.action.execute!(invalid)).rejects.toThrow();
    await expect(event.action.execute!({ ...event.draft, hidden: true })).rejects.toThrow();
    await expect(
      event.action.execute!({
        type: "memo",
        form: { title: "", content: "不要跨操作写入", pinned: false, tags: [] },
      }),
    ).rejects.toThrow("类型");
    await assertEmpty(data);
    const reminder = await proposal("reminders_create", {
      title: "读书",
      due: "2026-11-18T15:00",
      repeat: { preset: "daily" },
    });
    if (reminder.draft.type !== "reminder") throw new Error("测试类型错误");
    reminder.draft.form.timed = false;
    expect(validateAiCreateDraft(reminder.draft)).toEqual([]);
    expect(reminderFields(reminder.draft.form).rrule).toBeNull();
    expect(aiCreateSummary(reminder.draft)).toContain("不重复");
    expect(aiCreateSummary(reminder.draft)).not.toContain("每天");
  });
});

describe("AI 重复规则转换与摘要", () => {
  const start = parseLocalTime("2026-11-18T15:00", zone);
  const presets: AiRepeat["preset"][] = ["daily", "workdays", "weekly", "monthly", "yearly"];
  const ends: NonNullable<AiRepeat["end"]>[] = [
    { type: "never" },
    { type: "until", until: "2026-11-30" },
    { type: "count", count: 9 },
  ];
  it.each(presets.flatMap((preset) => ends.map((end) => ({ preset, end }))))(
    "$preset × $end.type 使用既有 buildRule",
    ({ preset, end }) => {
      const repeat = aiRepeatDraft(
        { preset, end, ...(preset === "weekly" ? { weekdays: [7, 2, 2, 4] } : {}) },
        start,
        zone,
      );
      const rule = buildRule(repeat, start, zone)!;
      const parsed = parseRule(rule);
      expect(parsed.freq).toBe(
        {
          daily: RRule.DAILY,
          workdays: RRule.WEEKLY,
          weekly: RRule.WEEKLY,
          monthly: RRule.MONTHLY,
          yearly: RRule.YEARLY,
        }[preset],
      );
      if (preset === "weekly") {
        expect(repeat.weekdays).toEqual([1, 3, 6]);
        expect(rule).toContain("BYDAY=TU,TH,SU");
      }
      if (preset === "workdays") expect(rule).toContain("BYDAY=MO,TU,WE,TH,FR");
      if (preset === "monthly" || preset === "yearly") expect(rule).toContain("BYMONTHDAY=18");
      if (preset === "yearly") expect(rule).toContain("BYMONTH=11");
      if (end.type === "count") expect(parsed.count).toBe(9);
      if (end.type === "until")
        expect(parsed.until?.getTime()).toBe(parseLocalTime("2026-12-01", zone) - 1_000);
      if (end.type === "never") {
        expect(parsed.count).toBeUndefined();
        expect(parsed.until).toBeUndefined();
      }
    },
  );

  it("没有指定星期沿用开始日期，摘要显示星期、中文重复，编辑中的不完整字段不会崩溃", () => {
    const repeat = aiRepeatDraft({ preset: "weekly" }, start, zone);
    expect(repeat.weekdays).toEqual([2]);
    const draft: AiCreateDraft = {
      type: "event",
      form: {
        title: "组会",
        notes: "",
        start: "2026-11-18T15:00",
        end: "2026-11-18T16:00",
        allDay: false,
        zone,
        color: "#547c69",
        reminder: null,
        repeat,
      },
    };
    expect(aiCreateSummary(draft)).toContain("周三");
    expect(aiCreateSummary(draft)).toContain("每周三");
    draft.form.start = "";
    draft.form.end = "2026-02-30";
    draft.form.repeat = { ...repeat, end: "count", count: "" };
    expect(() => aiCreateSummary(draft)).not.toThrow();
    expect(aiCreateSummary(draft)).toContain("待填写");
  });
});
