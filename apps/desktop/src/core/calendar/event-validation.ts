import { parseRule } from "./recurrence";
import type { EventFields } from "../repositories/models";

export function validateEvent(fields: EventFields): void {
  if (
    typeof fields.title !== "string" ||
    typeof fields.notes !== "string" ||
    typeof fields.all_day !== "boolean"
  )
    throw new Error("日程字段无效");
  if (
    !Number.isSafeInteger(fields.start_at) ||
    !Number.isSafeInteger(fields.end_at) ||
    fields.end_at < fields.start_at
  )
    throw new Error("日程起止时间无效");
  new Intl.DateTimeFormat("en", { timeZone: fields.timezone }).format(fields.start_at);
  if (fields.rrule !== null) {
    parseRule(fields.rrule);
  }
  if (!Array.isArray(fields.exdates) || !fields.exdates.every(Number.isSafeInteger))
    throw new Error("排除日期必须为毫秒时间戳");
  if ((fields.recurrence_id === null) !== (fields.original_start_at === null))
    throw new Error("例外日程必须同时记录原日程和原实例时间");
  if (fields.original_start_at !== null && !Number.isSafeInteger(fields.original_start_at))
    throw new Error("原实例时间无效");
  if (fields.recurrence_id !== null && fields.rrule !== null)
    throw new Error("例外日程不能再次重复");
  if (
    fields.remind_before_minutes !== null &&
    (!Number.isSafeInteger(fields.remind_before_minutes) || fields.remind_before_minutes < 0)
  )
    throw new Error("提前提醒分钟数无效");
}
