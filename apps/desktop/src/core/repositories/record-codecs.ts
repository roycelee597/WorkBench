import type { SqlRow, SqlValue } from "../db/database";
import type {
  CalendarEvent,
  JsonValue,
  Memo,
  RecordMetadata,
  Reminder,
  ReminderOccurrence,
  Setting,
} from "./models";

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`数据库字段 ${key} 不是字符串`);
  return value;
}
function number(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`数据库字段 ${key} 不是数字`);
  return value;
}
function nullableText(row: SqlRow, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}
function nullableNumber(row: SqlRow, key: string): number | null {
  return row[key] === null ? null : number(row, key);
}
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}
function json(row: SqlRow, key: string): JsonValue {
  const value: unknown = JSON.parse(text(row, key));
  if (!isJsonValue(value)) throw new Error(`数据库字段 ${key} 不是有效 JSON`);
  return value;
}
function metadata(row: SqlRow): RecordMetadata {
  return {
    id: text(row, "id"),
    created_at: number(row, "created_at"),
    updated_at: number(row, "updated_at"),
    deleted_at: nullableNumber(row, "deleted_at"),
    device_id: text(row, "device_id"),
    deletion_group_id: nullableText(row, "deletion_group_id"),
    purged_at: nullableNumber(row, "purged_at"),
  };
}
function stringArray(row: SqlRow, key: string): string[] {
  const value = json(row, key);
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
    throw new Error(`数据库字段 ${key} 不是字符串数组`);
  return value;
}
function numberArray(row: SqlRow, key: string): number[] {
  const value = json(row, key);
  if (
    !Array.isArray(value) ||
    !value.every((item): item is number => typeof item === "number" && Number.isSafeInteger(item))
  )
    throw new Error(`数据库字段 ${key} 不是时间戳数组`);
  return value;
}

export interface RecordDefinition<T> {
  table: "memos" | "events" | "reminders" | "settings" | "reminder_occurrences";
  columns: string[];
  order: string;
  cleared: Record<string, SqlValue>;
  decode: (row: SqlRow) => T;
}

export const memoDefinition: RecordDefinition<Memo> = {
  table: "memos",
  columns: ["title", "content", "pinned", "tags"],
  order: "pinned DESC, updated_at DESC, id",
  cleared: { title: "", content: "", pinned: 0, tags: "[]" },
  decode: (row) => ({
    ...metadata(row),
    title: text(row, "title"),
    content: text(row, "content"),
    pinned: number(row, "pinned") === 1,
    tags: stringArray(row, "tags"),
  }),
};
export const eventDefinition: RecordDefinition<CalendarEvent> = {
  table: "events",
  order: "start_at, id",
  columns: [
    "title",
    "notes",
    "start_at",
    "end_at",
    "all_day",
    "timezone",
    "rrule",
    "color",
    "source_workbench",
    "exdates",
    "recurrence_id",
    "original_start_at",
    "remind_before_minutes",
  ],
  cleared: {
    title: "",
    notes: "",
    start_at: 0,
    end_at: 0,
    all_day: 0,
    timezone: "UTC",
    rrule: null,
    color: null,
    source_workbench: null,
    exdates: "[]",
    recurrence_id: null,
    original_start_at: null,
    remind_before_minutes: null,
  },
  decode: (row) => ({
    ...metadata(row),
    title: text(row, "title"),
    notes: text(row, "notes"),
    start_at: number(row, "start_at"),
    end_at: number(row, "end_at"),
    all_day: number(row, "all_day") === 1,
    timezone: text(row, "timezone"),
    rrule: nullableText(row, "rrule"),
    color: nullableText(row, "color"),
    source_workbench: nullableText(row, "source_workbench"),
    exdates: numberArray(row, "exdates"),
    recurrence_id: nullableText(row, "recurrence_id"),
    original_start_at: nullableNumber(row, "original_start_at"),
    remind_before_minutes: nullableNumber(row, "remind_before_minutes"),
  }),
};
export const reminderDefinition: RecordDefinition<Reminder> = {
  table: "reminders",
  order: "due_at IS NULL, due_at, priority DESC, id",
  columns: [
    "title",
    "notes",
    "due_at",
    "rrule",
    "completed_at",
    "notified_at",
    "snooze_until",
    "priority",
    "event_id",
    "source_workbench",
    "source",
    "timezone",
    "recurrence_start_at",
    "schedule_version",
  ],
  cleared: {
    title: "",
    notes: "",
    due_at: null,
    rrule: null,
    completed_at: null,
    notified_at: null,
    snooze_until: null,
    priority: 0,
    event_id: null,
    source_workbench: null,
    source: "manual",
    timezone: "UTC",
    recurrence_start_at: null,
    schedule_version: "",
  },
  decode: (row) => {
    const source = text(row, "source");
    if (source !== "manual" && source !== "event") throw new Error("提醒来源无效");
    return {
      ...metadata(row),
      title: text(row, "title"),
      notes: text(row, "notes"),
      due_at: nullableNumber(row, "due_at"),
      rrule: nullableText(row, "rrule"),
      completed_at: nullableNumber(row, "completed_at"),
      notified_at: nullableNumber(row, "notified_at"),
      snooze_until: nullableNumber(row, "snooze_until"),
      priority: number(row, "priority"),
      event_id: nullableText(row, "event_id"),
      source_workbench: nullableText(row, "source_workbench"),
      source,
      timezone: text(row, "timezone"),
      recurrence_start_at: nullableNumber(row, "recurrence_start_at"),
      schedule_version: text(row, "schedule_version"),
    };
  },
};
export const reminderOccurrenceDefinition: RecordDefinition<ReminderOccurrence> = {
  table: "reminder_occurrences",
  columns: [
    "reminder_id",
    "occurrence_key",
    "schedule_key",
    "due_at",
    "title",
    "notes",
    "priority",
    "notified_at",
    "completed_at",
    "snooze_until",
  ],
  order: "due_at, id",
  cleared: {
    occurrence_key: "",
    schedule_key: "",
    due_at: null,
    title: "",
    notes: "",
    priority: 0,
    notified_at: null,
    completed_at: null,
    snooze_until: null,
  },
  decode: (row) => ({
    ...metadata(row),
    reminder_id: text(row, "reminder_id"),
    occurrence_key: text(row, "occurrence_key"),
    schedule_key: text(row, "schedule_key"),
    due_at: nullableNumber(row, "due_at"),
    title: text(row, "title"),
    notes: text(row, "notes"),
    priority: number(row, "priority"),
    notified_at: nullableNumber(row, "notified_at"),
    completed_at: nullableNumber(row, "completed_at"),
    snooze_until: nullableNumber(row, "snooze_until"),
  }),
};
export const settingDefinition: RecordDefinition<Setting> = {
  table: "settings",
  columns: ["key", "value"],
  order: '"key"',
  cleared: { value: "null" },
  decode: (row) => ({ ...metadata(row), key: text(row, "key"), value: json(row, "value") }),
};
