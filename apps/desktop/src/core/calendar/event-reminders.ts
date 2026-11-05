import type { CalendarEvent, Reminder } from "../repositories/models";
import { expandEvents, type EventOccurrence, type TimeRange } from "./recurrence";

export interface EventReminderOccurrence {
  key: string;
  due_at: number;
  reminder: Reminder;
  occurrence: EventOccurrence;
}
// 关联提醒以日程实例为准再减提前量，保证跨日提前提醒也遵守 BYDAY、EXDATE 和例外。
// 这里只展开数据，不发送通知，也不推进调度状态。
export function expandEventReminders(
  events: readonly CalendarEvent[],
  reminders: readonly Reminder[],
  range: TimeRange,
): EventReminderOccurrence[] {
  const byEvent = new Map(
    reminders
      .filter(
        (row) =>
          row.source === "event" &&
          row.event_id !== null &&
          row.deleted_at === null &&
          row.purged_at === null,
      )
      .map((row) => [row.event_id!, row]),
  );
  const advance = Math.max(0, ...events.map((row) => (row.remind_before_minutes ?? 0) * 60_000));
  return expandEvents(events, { start: range.start, end: range.end + advance })
    .flatMap((occurrence) => {
      const reminder = byEvent.get(occurrence.event.id);
      const before = occurrence.event.remind_before_minutes;
      if (!reminder || before === null) return [];
      const due_at = occurrence.start_at - before * 60_000;
      return due_at >= range.start && due_at < range.end
        ? [{ key: `${reminder.id}:${occurrence.original_start_at}`, due_at, reminder, occurrence }]
        : [];
    })
    .sort((left, right) => left.due_at - right.due_at || left.key.localeCompare(right.key));
}
