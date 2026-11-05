import { seriesStarts } from "../calendar/recurrence";
import type { CalendarEvent, Reminder, ReminderOccurrence } from "../repositories/models";

export const SNOOZE_MS = 10 * 60_000;
const END = Date.UTC(9999, 11, 31, 23, 59, 59);
export const occurrenceKey = (reminder: Pick<Reminder, "id">, due: number | null) =>
  `${reminder.id}:${due ?? "todo"}`;
const active = (row: Reminder | CalendarEvent) => row.deleted_at === null && row.purged_at === null;
function nextStart(event: CalendarEvent, after: number): number | null {
  if (after + 1 >= END) return null;
  return seriesStarts(event, after + 1, END, 1)[0] ?? null;
}
export function nextReminderDue(
  reminder: Reminder,
  after: number,
  events: readonly CalendarEvent[],
): number | null {
  if (reminder.source === "event") {
    const event = events.find((row) => row.id === reminder.event_id && active(row));
    if (!event || event.remind_before_minutes === null) return null;
    if (event.recurrence_id && !events.some((row) => row.id === event.recurrence_id && active(row)))
      return null;
    const advance = event.remind_before_minutes * 60_000;
    const excluded = new Set([
      ...event.exdates,
      ...events
        .filter((row) => row.recurrence_id === event.id && active(row))
        .map((row) => row.original_start_at!),
    ]);
    let cursor = after + advance;
    for (let count = 0; count < 1_000_000; count++) {
      const start = nextStart(event, cursor);
      if (start === null) return null;
      if (!excluded.has(start)) return start - advance;
      cursor = start;
    }
    throw new Error("日程排除实例过多");
  }
  if (reminder.due_at === null) return null;
  if (!reminder.rrule) return reminder.due_at > after ? reminder.due_at : null;
  const anchor = reminder.recurrence_start_at ?? reminder.due_at;
  const event: CalendarEvent = {
    ...reminder,
    start_at: anchor,
    end_at: anchor,
    all_day: false,
    rrule: reminder.rrule,
    timezone: reminder.timezone,
    color: null,
    exdates: [],
    recurrence_id: null,
    original_start_at: null,
    remind_before_minutes: null,
  };
  return nextStart(event, after);
}
export function validOccurrence(
  row: ReminderOccurrence,
  reminder: Reminder,
  events: readonly CalendarEvent[],
): boolean {
  if (row.schedule_key !== reminder.schedule_version || !active(reminder)) return false;
  if (row.due_at === null) return reminder.due_at === null;
  if (reminder.source === "manual" && !reminder.rrule) return row.due_at === reminder.due_at;
  return nextReminderDue(reminder, row.due_at - 1, events) === row.due_at;
}
export function nextAfterOccurrence(
  reminder: Reminder,
  due: number | null,
  now: number,
  events: readonly CalendarEvent[],
): number | null {
  if (due === null || (reminder.source === "manual" && !reminder.rrule)) return null;
  return nextReminderDue(reminder, Math.max(now, due), events);
}
