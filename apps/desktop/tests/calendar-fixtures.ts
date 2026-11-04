import type { CalendarEvent } from "../src/core/repositories/models";
export const DAY = 86_400_000;
export const at = (day: number, hour = 9) => Date.UTC(2026, 0, day, hour);
export function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "series",
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    device_id: "device",
    deletion_group_id: null,
    purged_at: null,
    title: "原日程",
    notes: "",
    start_at: at(1),
    end_at: at(1, 10),
    all_day: false,
    timezone: "UTC",
    rrule: "FREQ=DAILY;COUNT=5",
    color: null,
    source_workbench: null,
    exdates: [],
    recurrence_id: null,
    original_start_at: null,
    remind_before_minutes: null,
    ...patch,
  };
}
export function exception(day: number, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return event({
    id: `exception-${day}`,
    recurrence_id: "series",
    original_start_at: at(day),
    start_at: at(day, 11),
    end_at: at(day, 12),
    rrule: null,
    ...patch,
  });
}
export const range = { start: at(1, 0), end: at(10, 0) };
