import type { SqlStatement, SqlValue } from "../db/database";
import type { CalendarEvent, Reminder, RepositoryContext } from "./models";
import { insertStatement, updateStatement } from "./sql-statements";

export function eventReminderStatements(
  event: CalendarEvent,
  existing: Reminder[],
  context: RepositoryContext,
): SqlStatement[] {
  const now = context.now();
  const active = existing.filter(
    (row) =>
      row.event_id === event.id &&
      row.source === "event" &&
      row.deleted_at === null &&
      row.purged_at === null,
  );
  const retire = (row: Reminder) =>
    updateStatement(
      "reminders",
      {
        deleted_at: now,
        updated_at: now,
        device_id: context.deviceId,
        deletion_group_id: context.newId(),
      },
      "id = ? AND deleted_at IS NULL",
      [row.id],
    );
  if (event.remind_before_minutes === null) return active.map(retire);
  const fields: Record<string, SqlValue> = {
    title: event.title,
    notes: event.notes,
    due_at: event.start_at - event.remind_before_minutes * 60_000,
    rrule: event.rrule,
    event_id: event.id,
    source: "event",
    source_workbench: event.source_workbench,
    updated_at: now,
    device_id: context.deviceId,
  };
  if (active[0]) {
    const current = active[0];
    if (current.due_at !== fields.due_at || current.rrule !== fields.rrule)
      Object.assign(fields, { completed_at: null, notified_at: null, snooze_until: null });
    return [
      {
        ...updateStatement(
          "reminders",
          fields,
          "id = ? AND deleted_at IS NULL AND purged_at IS NULL",
          [current.id],
        ),
        expectedRows: 1,
      },
      ...active.slice(1).map(retire),
    ];
  }
  const statement = insertStatement("reminders", {
    id: context.newId(),
    created_at: now,
    deleted_at: null,
    deletion_group_id: null,
    purged_at: null,
    priority: 0,
    completed_at: null,
    notified_at: null,
    snooze_until: null,
    ...fields,
  });
  // 同一事务中检查，避免多个窗口在缺少关联提醒时重复创建；不改已发布迁移。
  const fieldsCount = statement.values.length;
  statement.query =
    statement.query.slice(0, statement.query.indexOf(" VALUES")) +
    ` SELECT ${Array(fieldsCount).fill("?").join(", ")} WHERE NOT EXISTS (SELECT 1 FROM reminders WHERE event_id = ? AND source = 'event' AND deleted_at IS NULL AND purged_at IS NULL)`;
  statement.values.push(event.id);
  statement.expectedRows = 1;
  return [statement];
}
