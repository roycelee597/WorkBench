import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { RRule, type Options } from "rrule";
import {
  floatingTime,
  timestampFromFloating,
  parseRule,
  serializeRule,
  seriesStarts,
  type EventOccurrence,
} from "../../../apps/desktop/src/core/calendar/recurrence";
import type {
  SeriesPatch,
  SeriesScope,
} from "../../../apps/desktop/src/core/calendar/series-mutations";
import type { CalendarEvent } from "../../../apps/desktop/src/core/repositories/models";

dayjs.extend(utc);
dayjs.extend(timezone);
const DAY = 86_400_000;
export const eventColors = [
  { value: "#547c69", name: "松绿" },
  { value: "#4f7db5", name: "湖蓝" },
  { value: "#8b6bb1", name: "藤紫" },
  { value: "#c57d43", name: "暖橙" },
  { value: "#be6473", name: "玫红" },
  { value: "#81878d", name: "岩灰" },
] as const;
export const reminderChoices = [
  { value: null, label: "不提醒" },
  { value: 0, label: "准时" },
  { value: 5, label: "提前 5 分钟" },
  { value: 10, label: "提前 10 分钟" },
  { value: 15, label: "提前 15 分钟" },
  { value: 30, label: "提前 30 分钟" },
  { value: 60, label: "提前 1 小时" },
  { value: 1440, label: "提前 1 天" },
] as const;
export const repeatChoices = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "workdays", label: "工作日（周一至五）" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月（按日期）" },
  { value: "yearly", label: "每年" },
] as const;
export type RepeatPreset = (typeof repeatChoices)[number]["value"];
export interface RepeatDraft {
  preset: RepeatPreset;
  weekdays: number[];
  end: "never" | "until" | "count";
  until: string;
  count: string;
}
export interface EventDraft {
  title: string;
  notes: string;
  start: string;
  end: string;
  allDay: boolean;
  zone: string;
  color: string;
  reminder: number | null;
  repeat: RepeatDraft;
}
export const dateInZone = (value: number, zone: string) =>
  dayjs(value).tz(zone).format("YYYY-MM-DD");
export const timeInZone = (value: number, zone: string) =>
  dayjs(value).tz(zone).format("YYYY-MM-DDTHH:mm");

export function parseLocal(value: string, zone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value)) throw new Error("请填写完整的日期和时间");
  const normalized = value.length === 10 ? `${value}T00:00` : value;
  const wall = Date.parse(`${normalized}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== normalized)
    throw new Error("日期或时间无效");
  const result = timestampFromFloating(wall, zone);
  if (result === null) throw new Error("该时区在此刻因夏令时跳过了这个时间，请选择其他时间");
  return result;
}
export function shiftDay(value: string, days: number): string {
  return new Date(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}
const weekday = (stamp: number, zone: string) =>
  (new Date(floatingTime(stamp, zone)).getUTCDay() + 6) % 7;
export function readRepeat(rule: string | null, start: number, zone: string): RepeatDraft {
  const result: RepeatDraft = {
    preset: "none",
    weekdays: [weekday(start, zone)],
    end: "never",
    until: dateInZone(start, zone),
    count: "10",
  };
  if (!rule) return result;
  const options = parseRule(rule);
  const weekdays = new RRule({ ...options, dtstart: new Date(floatingTime(start, zone)) }).options
    .byweekday;
  result.preset =
    options.freq === RRule.DAILY
      ? "daily"
      : options.freq === RRule.MONTHLY
        ? "monthly"
        : options.freq === RRule.YEARLY
          ? "yearly"
          : weekdays.join(",") === "0,1,2,3,4"
            ? "workdays"
            : "weekly";
  if (options.freq === RRule.WEEKLY && weekdays.length) result.weekdays = [...weekdays];
  if (options.count != null) {
    result.end = "count";
    result.count = String(options.count);
  } else if (options.until) {
    result.end = "until";
    result.until = dateInZone(options.until.getTime(), zone);
  }
  return result;
}
export function buildRule(draft: RepeatDraft, start: number, zone: string): string | null {
  if (draft.preset === "none") return null;
  const date = new Date(floatingTime(start, zone));
  const options: Partial<Options> = {
    freq:
      draft.preset === "daily"
        ? RRule.DAILY
        : draft.preset === "monthly"
          ? RRule.MONTHLY
          : draft.preset === "yearly"
            ? RRule.YEARLY
            : RRule.WEEKLY,
  };
  if (draft.preset === "workdays") {
    options.byweekday = [0, 1, 2, 3, 4];
  }
  if (draft.preset === "weekly") {
    if (
      !draft.weekdays.length ||
      draft.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    )
      throw new Error("每周重复至少选择一个星期");
    options.byweekday = [...new Set(draft.weekdays)].sort();
  }
  if (draft.preset === "monthly" || draft.preset === "yearly")
    options.bymonthday = date.getUTCDate();
  if (draft.preset === "yearly") options.bymonth = date.getUTCMonth() + 1;
  if (draft.end === "count") {
    const count = Number(draft.count);
    if (!/^\d+$/.test(draft.count) || !Number.isSafeInteger(count) || count < 1)
      throw new Error("重复次数请输入正整数");
    options.count = count;
  }
  if (draft.end === "until") {
    const until = parseLocal(shiftDay(draft.until, 1), zone) - 1;
    if (until < start) throw new Error("重复结束日期不能早于开始日期");
    options.until = new Date(until);
  }
  return serializeRule(options);
}
export function newEventDraft(
  start: number,
  end: number,
  allDay: boolean,
  reminder: number | null,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): EventDraft {
  return {
    title: "",
    notes: "",
    start: allDay ? dateInZone(start, zone) : timeInZone(start, zone),
    end: allDay ? shiftDay(dateInZone(end, zone), -1) : timeInZone(end, zone),
    allDay,
    zone,
    color: eventColors[0].value,
    reminder,
    repeat: readRepeat(null, start, zone),
  };
}
export function occurrenceDraft(occurrence: EventOccurrence, series: CalendarEvent): EventDraft {
  return {
    ...newEventDraft(
      occurrence.start_at,
      occurrence.end_at,
      occurrence.event.all_day,
      occurrence.event.remind_before_minutes,
      occurrence.event.timezone,
    ),
    title: occurrence.event.title,
    notes: occurrence.event.notes,
    color: occurrence.event.color ?? eventColors[0].value,
    repeat: readRepeat(series.rrule, series.start_at, series.timezone),
  };
}
export function toggleAllDay(draft: EventDraft, allDay: boolean): EventDraft {
  return {
    ...draft,
    allDay,
    start: allDay ? draft.start.slice(0, 10) : `${draft.start.slice(0, 10)}T09:00`,
    end: allDay ? draft.end.slice(0, 10) : `${draft.end.slice(0, 10)}T10:00`,
  };
}
export function draftFields(
  draft: EventDraft,
  includeRule = true,
): SeriesPatch & { title: string; start_at: number; end_at: number; timezone: string } {
  const start = parseLocal(draft.start, draft.zone);
  const end = parseLocal(draft.allDay ? shiftDay(draft.end, 1) : draft.end, draft.zone);
  if (!draft.title.trim()) throw new Error("请填写日程标题");
  if (end <= start) throw new Error("结束时间必须晚于开始时间");
  if (!eventColors.some((color) => color.value === draft.color))
    throw new Error("请选择一种日程颜色");
  if (!reminderChoices.some((choice) => choice.value === draft.reminder))
    throw new Error("提前提醒选项无效");
  return {
    title: draft.title.trim(),
    notes: draft.notes,
    start_at: start,
    end_at: end,
    all_day: draft.allDay,
    timezone: draft.zone,
    color: draft.color,
    remind_before_minutes: draft.reminder,
    ...(includeRule ? { rrule: buildRule(draft.repeat, start, draft.zone) } : {}),
  };
}
// 只提交用户改过的字段；否则编辑例外标题时会把例外时间复制到整个系列。
export function draftPatch(draft: EventDraft, initial: EventDraft): SeriesPatch {
  const fields = draftFields(draft, false);
  const before = draftFields(initial, false);
  const patch: SeriesPatch = {};
  for (const key of [
    "title",
    "notes",
    "all_day",
    "timezone",
    "color",
    "remind_before_minutes",
  ] as const)
    if (fields[key] !== before[key]) Object.assign(patch, { [key]: fields[key] });
  if (draft.start !== initial.start || draft.allDay !== initial.allDay) {
    patch.start_at = fields.start_at;
    patch.end_at = fields.end_at;
  }
  if (draft.end !== initial.end || draft.allDay !== initial.allDay) patch.end_at = fields.end_at;
  if (JSON.stringify(draft.repeat) !== JSON.stringify(initial.repeat))
    patch.rrule = buildRule(draft.repeat, fields.start_at, draft.zone);
  return patch;
}
// 拖动按日期的重复日程时，星期/月份日期跟随位移；未改变结束条件时保留原有 COUNT 供纯函数拆分。
export function reanchorRule(
  rule: string,
  oldStart: number,
  newStart: number,
  zone: string,
): string {
  const options = parseRule(rule);
  const oldDate = new Date(floatingTime(oldStart, zone));
  const newDate = new Date(floatingTime(newStart, zone));
  if (options.freq === RRule.WEEKLY && options.byweekday != null) {
    const delta = Math.round(
      (Date.UTC(newDate.getUTCFullYear(), newDate.getUTCMonth(), newDate.getUTCDate()) -
        Date.UTC(oldDate.getUTCFullYear(), oldDate.getUTCMonth(), oldDate.getUTCDate())) /
        DAY,
    );
    options.byweekday = new RRule(options).options.byweekday
      .map((day) => (day + (delta % 7) + 7) % 7)
      .sort();
  }
  if (options.freq === RRule.MONTHLY || options.freq === RRule.YEARLY)
    options.bymonthday = newDate.getUTCDate();
  if (options.freq === RRule.YEARLY) options.bymonth = newDate.getUTCMonth() + 1;
  return serializeRule(options);
}
export function scopedPatch(
  patch: SeriesPatch,
  occurrence: EventOccurrence,
  series: CalendarEvent,
  scope: SeriesScope,
): SeriesPatch {
  if (scope === "this") {
    const result = { ...patch };
    delete result.rrule;
    return result;
  }
  if (patch.start_at === undefined && patch.end_at !== undefined)
    patch = { ...patch, end_at: occurrence.original_start_at + patch.end_at - occurrence.start_at };
  if (patch.start_at === undefined || patch.rrule !== undefined || !series.rrule) return patch;
  const rule = reanchorRule(
    series.rrule,
    occurrence.original_start_at,
    patch.start_at,
    series.timezone,
  );
  if (rule === serializeRule(parseRule(series.rrule))) return patch;
  // 显式更新 RRULE 时，保留“此后全部”的剩余次数，而不是重置原来的次数。
  const options = parseRule(rule);
  if (scope === "following" && options.count != null) {
    const countBefore =
      occurrence.original_start_at === series.start_at
        ? 0
        : seriesStarts(series, series.start_at, occurrence.original_start_at).length;
    options.count = Math.max(1, options.count - countBefore);
  }
  return { ...patch, rrule: serializeRule(options) };
}
