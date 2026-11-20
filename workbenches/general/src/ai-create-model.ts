import { z } from "zod";
import { parseLocalTime, formatLocalTime } from "../../../apps/desktop/src/core/ai/local-time";
import { normalizeTags, type MemoDraft } from "./api";
import {
  buildRule,
  draftFields,
  eventColors,
  readRepeat,
  reminderChoices,
  type EventDraft,
  type RepeatDraft,
} from "./calendar-model";
import { reminderFields, type ReminderFormDraft } from "./reminder-model";

const when = z.string().refine((value) => {
  try {
    parseLocalTime(value, "UTC");
    return true;
  } catch {
    return false;
  }
}, "日期或时间无效，请使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm");
const date = when.refine((value) => value.length === 10, "请只填写日期");
const repeatEndSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("never") }).strict(),
  z.object({ type: z.literal("until"), until: date }).strict(),
  z.object({ type: z.literal("count"), count: z.number().int().min(1).max(999) }).strict(),
]);
export const aiRepeatSchema = z
  .object({
    preset: z.enum(["daily", "workdays", "weekly", "monthly", "yearly"]),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    end: repeatEndSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.weekdays && value.preset !== "weekly")
      ctx.addIssue({ code: "custom", message: "只有每周重复可以指定星期", path: ["weekdays"] });
  });
export type AiRepeat = z.infer<typeof aiRepeatSchema>;
const title = z.string().trim().min(1, "请填写标题");
export const eventCreateArgsSchema = z
  .object({
    title,
    notes: z.string().optional(),
    start: when,
    end: when.optional(),
    duration_minutes: z.number().int().min(1).max(10_080).optional(),
    all_day: z.boolean().optional(),
    repeat: aiRepeatSchema.optional(),
    remind_before_minutes: z.number().int().nonnegative().safe().nullable().optional(),
  })
  .strict();
export const reminderCreateArgsSchema = z
  .object({
    title,
    notes: z.string().optional(),
    due: when.nullable(),
    repeat: aiRepeatSchema.optional(),
    priority: z.number().int().min(0).max(3).optional(),
  })
  .strict();
export const memoCreateArgsSchema = z
  .object({
    title: z.string().optional(),
    content: z.string().min(1, "请填写备忘录正文"),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export type AiCreateEventDraft = { type: "event"; form: EventDraft };
export type AiCreateReminderDraft = { type: "reminder"; form: ReminderFormDraft };
export type AiCreateMemoDraft = { type: "memo"; form: MemoDraft };
export type AiCreateDraft = AiCreateEventDraft | AiCreateReminderDraft | AiCreateMemoDraft;

const repeatDraftSchema = z
  .object({
    preset: z.enum(["none", "daily", "workdays", "weekly", "monthly", "yearly"]),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    end: z.enum(["never", "until", "count"]),
    until: z.string(),
    count: z.string(),
  })
  .strict();
const aiCreateDraftSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("event"),
      form: z
        .object({
          title: z.string(),
          notes: z.string(),
          start: z.string(),
          end: z.string(),
          allDay: z.boolean(),
          zone: z.string(),
          color: z.string(),
          reminder: z.number().nullable(),
          repeat: repeatDraftSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reminder"),
      form: z
        .object({
          title: z.string(),
          notes: z.string(),
          timed: z.boolean(),
          due: z.string(),
          zone: z.string(),
          priority: z.number().int().min(0).max(3),
          repeat: repeatDraftSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("memo"),
      form: z
        .object({
          title: z.string(),
          content: z.string(),
          pinned: z.boolean(),
          tags: z.array(z.string()),
        })
        .strict(),
    })
    .strict(),
]);

export function aiRepeatDraft(
  value: AiRepeat | undefined,
  start: number,
  zone: string,
): RepeatDraft {
  const draft = readRepeat(null, start, zone);
  if (!value) return draft;
  const repeat = aiRepeatSchema.parse(value);
  draft.preset = repeat.preset;
  if (repeat.weekdays) draft.weekdays = [...new Set(repeat.weekdays.map((day) => day - 1))].sort();
  if (repeat.end?.type === "until") {
    draft.end = "until";
    draft.until = repeat.end.until;
  }
  if (repeat.end?.type === "count") {
    draft.end = "count";
    draft.count = String(repeat.end.count);
  }
  buildRule(draft, start, zone);
  return draft;
}

function validateRepeat(draft: RepeatDraft, zone: string): void {
  if (draft.preset === "none") return;
  if (draft.end === "until") parseLocalTime(date.parse(draft.until), zone);
  if (
    draft.end === "count" &&
    (!/^\d+$/.test(draft.count) || Number(draft.count) < 1 || Number(draft.count) > 999)
  )
    throw new Error("重复次数须为 1–999 的整数");
}

/** 只接受已知表单字段；转交手动表单和确认写入前都重新检查。 */
export function parseAiCreateDraft(value: unknown): AiCreateDraft {
  const draft = aiCreateDraftSchema.parse(value);
  if (draft.type === "memo") {
    if (!draft.form.content.trim()) throw new Error("请填写备忘录正文");
    return { ...draft, form: { ...draft.form, tags: normalizeTags(draft.form.tags) } };
  }
  const form = draft.form;
  formatLocalTime(0, form.zone);
  if (draft.type === "event" || draft.form.timed) validateRepeat(form.repeat, form.zone);
  if (draft.type === "event") {
    const { form: event } = draft;
    if (event.allDay && (event.start.length !== 10 || event.end.length !== 10))
      throw new Error("全天日程请填写日期");
    if (!event.allDay && (event.start.length !== 16 || event.end.length !== 16))
      throw new Error("请填写日程开始和结束时间");
    parseLocalTime(event.start, event.zone);
    parseLocalTime(event.end, event.zone);
    draftFields(event);
  } else {
    if (draft.form.timed) parseLocalTime(draft.form.due, draft.form.zone);
    reminderFields(draft.form);
  }
  return draft;
}

export function validateAiCreateDraft(value: unknown): string[] {
  try {
    parseAiCreateDraft(value);
    return [];
  } catch (failure) {
    return [
      failure instanceof z.ZodError
        ? "草稿字段无效，请检查填写内容"
        : failure instanceof Error
          ? failure.message
          : "草稿无效，请重新填写",
    ];
  }
}

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export function aiRepeatSummary(repeat: RepeatDraft): string {
  const preset =
    repeat.preset === "weekly"
      ? `每${repeat.weekdays.map((day) => weekdays[day] ?? "?").join("、") || "周（待选择星期）"}`
      : {
          none: "不重复",
          daily: "每天",
          workdays: "工作日（周一至五）",
          monthly: "每月（按日期）",
          yearly: "每年",
        }[repeat.preset];
  return `${preset}${repeat.preset === "none" || repeat.end === "never" ? "" : repeat.end === "until" ? `，到 ${repeat.until || "待填写"}` : `，共 ${repeat.count || "待填写"} 次`}`;
}
function localSummary(value: string, zone: string): string {
  try {
    const stamp = parseLocalTime(value, zone);
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: zone }).format(
      stamp,
    );
    const local = formatLocalTime(stamp, zone, value.length === 10);
    return `${local.slice(0, 10)} ${weekday}${local.length > 10 ? ` ${local.slice(11)}` : ""}`;
  } catch {
    return value || "时间待填写";
  }
}
/** 编辑中的表单可以暂时不完整，摘要始终容错显示。 */
export function aiCreateSummary(draft: AiCreateDraft): string {
  if (draft.type === "memo")
    return `新建备忘录 · ${draft.form.title.trim() || "未命名备忘录"}${draft.form.tags.length ? ` · ${draft.form.tags.join("、")}` : ""}`;
  if (draft.type === "event")
    return `新建日程 · ${localSummary(draft.form.start, draft.form.zone)} — ${localSummary(draft.form.end, draft.form.zone)}${draft.form.allDay ? "（全天，含结束当天）" : ""} · ${aiRepeatSummary(draft.form.repeat)}`;
  return `新建提醒 · ${draft.form.timed ? localSummary(draft.form.due, draft.form.zone) : "无到期时间"} · ${draft.form.timed ? aiRepeatSummary(draft.form.repeat) : "不重复"}`;
}

export const defaultAiEventColor = eventColors[0].value;
export function nearestAiReminder(value: number | null): number | null {
  if (value === null) return null;
  return (
    [...reminderChoices].reverse().find((choice) => choice.value !== null && choice.value <= value)
      ?.value ?? 0
  );
}
