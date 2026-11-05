import type { SqlDatabase, SqlStatement, SqlValue } from "../db/database";
import { SNOOZE_MS, occurrenceKey } from "../scheduler/reminder-time";
import { BaseRepository } from "./base-repository";
import type {
  CalendarEvent,
  Reminder,
  ReminderOccurrence,
  ReminderOccurrenceFields,
  RepositoryContext,
} from "./models";
import { reminderOccurrenceDefinition } from "./record-codecs";
import { encodeFields, insertStatement, updateStatement } from "./sql-statements";

function snapshot(row: Reminder | CalendarEvent) {
  const fields = encodeFields(row, Object.keys(row));
  return {
    where: Object.keys(fields)
      .map((key) => (key === "exdates" ? 'json("exdates") = json(?)' : `"${key}" IS ?`))
      .join(" AND "),
    values: Object.values(fields),
  };
}
const conflict = (error: unknown) =>
  String(error instanceof Error ? error.message : error).includes("内容已发生变化");
export class ReminderOccurrencesRepository extends BaseRepository<
  ReminderOccurrence,
  ReminderOccurrenceFields
> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, reminderOccurrenceDefinition);
  }
  async ensure(reminder: Reminder, due: number | null): Promise<ReminderOccurrence> {
    const key = occurrenceKey(reminder, due);
    const existing = await this.read(
      "occurrence_key = ? AND schedule_key = ? AND deleted_at IS NULL AND purged_at IS NULL",
      [key, reminder.schedule_version],
    );
    if (existing[0]) return existing[0];
    const now = this.context.now();
    const row: ReminderOccurrence = {
      id: this.context.newId(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
      device_id: this.context.deviceId,
      deletion_group_id: null,
      purged_at: null,
      reminder_id: reminder.id,
      occurrence_key: key,
      schedule_key: reminder.schedule_version,
      due_at: due,
      title: reminder.title,
      notes: reminder.notes,
      priority: reminder.priority,
      notified_at: due === reminder.due_at ? reminder.notified_at : null,
      completed_at: due === reminder.due_at ? reminder.completed_at : null,
      snooze_until: due === reminder.due_at ? reminder.snooze_until : null,
    };
    const statement = insertStatement("reminder_occurrences", encodeFields(row, Object.keys(row)));
    statement.query += " ON CONFLICT DO NOTHING";
    await this.db.batch([statement]);
    const saved = (
      await this.read(
        "occurrence_key = ? AND schedule_key = ? AND deleted_at IS NULL AND purged_at IS NULL",
        [key, reminder.schedule_version],
      )
    )[0];
    if (!saved) throw new Error("未能保存提醒实例");
    return saved;
  }
  private metadata() {
    return { updated_at: this.context.now(), device_id: this.context.deviceId };
  }
  private guarded(
    row: ReminderOccurrence,
    parent: Reminder,
    fields: Record<string, SqlValue>,
    events: readonly CalendarEvent[] = [],
  ): SqlStatement {
    const guards = [
      { table: "reminders", row: parent },
      ...events.map((row) => ({ table: "events", row })),
    ].map(({ table, row }) => {
      const guard = snapshot(row);
      return {
        where: `EXISTS (SELECT 1 FROM ${table} WHERE ${guard.where})`,
        values: guard.values,
      };
    });
    return {
      ...updateStatement(
        "reminder_occurrences",
        { ...fields, ...this.metadata() },
        `id = ? AND deleted_at IS NULL AND purged_at IS NULL AND completed_at IS NULL AND notified_at IS ? AND snooze_until IS ? AND ${guards.map((guard) => guard.where).join(" AND ")}`,
        [row.id, row.notified_at, row.snooze_until, ...guards.flatMap((guard) => guard.values)],
      ),
      expectedRows: 1,
    };
  }
  private parentUpdate(parent: Reminder, fields: Record<string, SqlValue>): SqlStatement {
    const guard = snapshot(parent);
    return {
      ...updateStatement("reminders", { ...fields, ...this.metadata() }, guard.where, guard.values),
      expectedRows: 1,
    };
  }
  private canAdvance(row: ReminderOccurrence, parent: Reminder) {
    return (
      row.schedule_key === parent.schedule_version &&
      (row.due_at === null
        ? parent.due_at === null
        : parent.due_at !== null && parent.due_at <= row.due_at)
    );
  }
  private async commit(statements: SqlStatement[]): Promise<boolean> {
    try {
      await this.db.batch(statements);
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }
  async claim(
    row: ReminderOccurrence,
    parent: Reminder,
    nextDue: number | null,
    eventGuards: readonly CalendarEvent[] = [],
    claimedAt = this.context.now(),
  ): Promise<boolean> {
    const now = claimedAt;
    if (
      row.completed_at !== null ||
      row.notified_at !== null ||
      row.due_at === null ||
      (row.snooze_until ?? row.due_at) > now ||
      row.schedule_key !== parent.schedule_version
    )
      return false;
    const statements = [
      this.guarded(row, parent, { notified_at: now, snooze_until: null }, eventGuards),
    ];
    if (this.canAdvance(row, parent))
      statements.push(
        this.parentUpdate(
          parent,
          nextDue === null
            ? { due_at: row.due_at, notified_at: now, snooze_until: null }
            : { due_at: nextDue, notified_at: null, snooze_until: null, completed_at: null },
        ),
      );
    return this.commit(statements);
  }
  async complete(
    row: ReminderOccurrence,
    parent: Reminder,
    nextDue: number | null,
    eventGuards: readonly CalendarEvent[] = [],
  ): Promise<boolean> {
    if (row.completed_at !== null || row.schedule_key !== parent.schedule_version) return false;
    const now = this.context.now();
    const statements = [
      this.guarded(row, parent, { completed_at: now, snooze_until: null }, eventGuards),
    ];
    if (this.canAdvance(row, parent))
      statements.push(
        this.parentUpdate(
          parent,
          nextDue === null
            ? { completed_at: now, snooze_until: null }
            : { due_at: nextDue, completed_at: null, notified_at: null, snooze_until: null },
        ),
      );
    return this.commit(statements);
  }
  async snooze(row: ReminderOccurrence, parent: Reminder): Promise<boolean> {
    if (
      row.completed_at !== null ||
      row.due_at === null ||
      row.schedule_key !== parent.schedule_version
    )
      return false;
    const until = this.context.now() + SNOOZE_MS;
    const statements = [this.guarded(row, parent, { snooze_until: until, notified_at: null })];
    if (parent.due_at === row.due_at)
      statements.push(this.parentUpdate(parent, { snooze_until: until, notified_at: null }));
    return this.commit(statements);
  }
  async retryNotification(id: string, claimedAt: number): Promise<void> {
    const row = await this.get(id);
    if (!row || row.completed_at !== null || row.notified_at !== claimedAt) return;
    await this.db.batch([
      updateStatement(
        "reminder_occurrences",
        { notified_at: null, ...this.metadata() },
        "id = ? AND completed_at IS NULL AND notified_at = ? AND snooze_until IS NULL",
        [id, claimedAt],
      ),
      updateStatement(
        "reminders",
        { notified_at: null, ...this.metadata() },
        "id = ? AND due_at IS ? AND schedule_version = ? AND notified_at = ? AND completed_at IS NULL",
        [row.reminder_id, row.due_at, row.schedule_key, claimedAt],
      ),
    ]);
  }
}
