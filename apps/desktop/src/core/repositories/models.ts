export type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export interface RecordMetadata {
  id: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  device_id: string;
  deletion_group_id: string | null;
  purged_at: number | null;
}

export interface MemoFields {
  title: string;
  content: string;
  pinned: boolean;
  tags: string[];
}
export interface Memo extends RecordMetadata, MemoFields {}

export interface EventFields {
  title: string;
  notes: string;
  start_at: number;
  end_at: number;
  all_day: boolean;
  timezone: string;
  rrule: string | null;
  color: string | null;
  source_workbench: string | null;
  exdates: number[];
  recurrence_id: string | null;
  original_start_at: number | null;
  remind_before_minutes: number | null;
}
export interface CalendarEvent extends RecordMetadata, EventFields {}
export type NewEvent = Pick<EventFields, "title" | "start_at" | "end_at"> &
  Partial<Omit<EventFields, "title" | "start_at" | "end_at">>;

export interface ReminderFields {
  title: string;
  notes: string;
  due_at: number | null;
  rrule: string | null;
  completed_at: number | null;
  notified_at: number | null;
  snooze_until: number | null;
  priority: number;
  event_id: string | null;
  source_workbench: string | null;
  source: "manual" | "event";
}
export interface Reminder extends RecordMetadata, ReminderFields {}
export type NewReminder = Pick<ReminderFields, "title"> & Partial<Omit<ReminderFields, "title">>;

export interface SettingFields {
  key: string;
  value: JsonValue;
}
export interface Setting extends RecordMetadata, SettingFields {}

export interface RepositoryContext {
  deviceId: string;
  now: () => number;
  newId: () => string;
}
