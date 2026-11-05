import type { DataLayer } from "../repositories";
import type { CalendarEvent, Reminder, ReminderOccurrence } from "../repositories/models";
import {
  nextAfterOccurrence,
  nextReminderDue,
  occurrenceKey,
  validOccurrence,
} from "./reminder-time";

export interface ReminderTarget {
  reminderId: string;
  occurrenceId?: string;
}
export interface ReminderItem {
  key: string;
  reminder: Reminder;
  occurrenceId: string | null;
  title: string;
  notes: string;
  priority: number;
  due_at: number | null;
  completed_at: number | null;
  notified_at: number | null;
  snooze_until: number | null;
  isCurrent: boolean;
}
export type ReminderData = Pick<DataLayer, "reminders" | "occurrences" | "events">;
export function eventGuards(reminder: Reminder, events: readonly CalendarEvent[]) {
  const event = events.find((row) => row.id === reminder.event_id);
  return event ? events.filter((row) => row.id === event.id || row.id === event.recurrence_id) : [];
}
export function currentReminderDue(
  reminder: Reminder,
  events: readonly CalendarEvent[],
): number | null {
  if (reminder.due_at === null) return null;
  if (reminder.source === "manual" && !reminder.rrule) return reminder.due_at;
  return nextReminderDue(reminder, reminder.due_at - 1, events);
}
export async function loadReminderItems(data: ReminderData): Promise<ReminderItem[]> {
  const [reminders, occurrences, events] = await Promise.all([
    data.reminders.list(),
    data.occurrences.list(),
    data.events.list(),
  ]);
  const result: ReminderItem[] = [];
  const used = new Set<string>();
  for (const reminder of reminders) {
    const due = currentReminderDue(reminder, events);
    if (reminder.due_at !== null && due === null && reminder.completed_at === null) continue;
    const current = occurrences.find(
      (row) =>
        row.reminder_id === reminder.id &&
        row.schedule_key === reminder.schedule_version &&
        row.occurrence_key === occurrenceKey(reminder, due),
    );
    if (current) used.add(current.id);
    result.push({
      key: current?.id ?? occurrenceKey(reminder, due),
      reminder,
      occurrenceId: current?.id ?? null,
      title: reminder.title,
      notes: reminder.notes,
      priority: reminder.priority,
      due_at: due,
      completed_at: current?.completed_at ?? reminder.completed_at,
      notified_at: current?.notified_at ?? reminder.notified_at,
      snooze_until: current?.snooze_until ?? reminder.snooze_until,
      isCurrent: true,
    });
  }
  for (const row of occurrences) {
    if (used.has(row.id)) continue;
    const parent = reminders.find((reminder) => reminder.id === row.reminder_id);
    if (!parent || (row.completed_at === null && !validOccurrence(row, parent, events))) continue;
    result.push({
      key: row.id,
      reminder: parent,
      occurrenceId: row.id,
      title: row.title,
      notes: row.notes,
      priority: row.priority,
      due_at: row.due_at,
      completed_at: row.completed_at,
      notified_at: row.notified_at,
      snooze_until: row.snooze_until,
      isCurrent: false,
    });
  }
  return result;
}
async function targetOccurrence(data: ReminderData, target: ReminderTarget) {
  const [parent, events] = await Promise.all([
    data.reminders.get(target.reminderId),
    data.events.list(),
  ]);
  if (!parent) throw new Error("提醒已删除，请刷新");
  const due = currentReminderDue(parent, events);
  if (parent.due_at !== null && due === null && !target.occurrenceId)
    throw new Error("此日程已经没有可用的提醒实例");
  const row = target.occurrenceId
    ? await data.occurrences.get(target.occurrenceId)
    : await data.occurrences.ensure(parent, due);
  if (!row || row.reminder_id !== parent.id || !validOccurrence(row, parent, events))
    throw new Error("此提醒的时间已改变，请刷新后重新操作");
  return { parent, events, row };
}
export async function completeReminder(data: ReminderData, target: ReminderTarget, now: number) {
  const { parent, events, row } = await targetOccurrence(data, target);
  if (row.completed_at !== null) return;
  if (
    !(await data.occurrences.complete(
      row,
      parent,
      nextAfterOccurrence(parent, row.due_at, now, events),
      eventGuards(parent, events),
    ))
  )
    throw new Error("提醒已发生变化，请刷新后重试");
}
export async function snoozeReminder(data: ReminderData, target: ReminderTarget) {
  const { parent, row } = await targetOccurrence(data, target);
  if (row.completed_at !== null) throw new Error("这次提醒已完成");
  if (row.due_at === null) throw new Error("无时间的待办不能贪睡");
  if (!(await data.occurrences.snooze(row, parent)))
    throw new Error("提醒已发生变化，请刷新后重试");
}
export function readyOccurrences(
  rows: readonly ReminderOccurrence[],
  parents: readonly Reminder[],
  events: readonly CalendarEvent[],
  now: number,
) {
  return rows
    .flatMap((row) => {
      const parent = parents.find((parent) => parent.id === row.reminder_id);
      return parent &&
        row.completed_at === null &&
        row.notified_at === null &&
        row.due_at !== null &&
        (row.snooze_until ?? row.due_at) <= now &&
        validOccurrence(row, parent, events)
        ? [{ row, parent }]
        : [];
    })
    .sort((a, b) => (a.row.snooze_until ?? a.row.due_at!) - (b.row.snooze_until ?? b.row.due_at!));
}
