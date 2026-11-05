import { validateEvent } from "../calendar/event-validation";
import {
  editSeries,
  deleteSeries,
  type EventChangeSet,
  type SeriesPatch,
  type SeriesScope,
} from "../calendar/series-mutations";
import type { SqlStatement, SqlValue, SqlRow } from "../db/database";
export { validateEvent } from "../calendar/event-validation";
import type { SqlDatabase } from "../db/database";
import { BaseRepository } from "./base-repository";
import type { CalendarEvent, EventFields, NewEvent, RepositoryContext } from "./models";
import { eventDefinition, reminderDefinition, reminderOccurrenceDefinition } from "./record-codecs";
import { encodeFields, insertStatement, updateStatement } from "./sql-statements";
import { eventReminderStatements } from "./event-reminder-sync";

export class EventsRepository extends BaseRepository<CalendarEvent, EventFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, eventDefinition);
  }
  async create(input: NewEvent): Promise<CalendarEvent> {
    const fields: EventFields = {
      notes: "",
      all_day: false,
      timezone: "Asia/Shanghai",
      rrule: null,
      color: null,
      source_workbench: null,
      exdates: [],
      recurrence_id: null,
      original_start_at: null,
      remind_before_minutes: null,
      ...input,
    };
    validateEvent(fields);
    const parent = await this.validateParent(fields);
    const now = this.context.now();
    const event: CalendarEvent = {
      ...fields,
      id: this.context.newId(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
      device_id: this.context.deviceId,
      deletion_group_id: null,
      purged_at: null,
    };
    const updated = parent
      ? [
          {
            ...parent,
            exdates: [...new Set([...parent.exdates, fields.original_start_at!])].sort(
              (a, b) => a - b,
            ),
            updated_at: now,
            device_id: this.context.deviceId,
          },
        ]
      : [];
    await this.commitChanges({ created: [event], updated }, parent ? [parent] : []);
    return this.requireActive(event.id);
  }
  async update(id: string, patch: Partial<EventFields>): Promise<CalendarEvent> {
    const current = await this.requireActive(id);
    encodeFields(patch, this.definition.columns);
    const fields = { ...current, ...patch };
    validateEvent(fields);
    if (fields.recurrence_id === id) throw new Error("日程不能引用自身");
    await this.validateParent(fields);
    await this.commitChanges(
      {
        created: [],
        updated: [{ ...fields, updated_at: this.context.now(), device_id: this.context.deviceId }],
      },
      [current],
    );
    return this.requireActive(id);
  }
  private async validateParent(fields: EventFields): Promise<CalendarEvent | null> {
    if (fields.recurrence_id === null) return null;
    const parent = await this.get(fields.recurrence_id);
    if (
      !parent ||
      parent.recurrence_id !== null ||
      (parent.rrule === null && !parent.exdates.includes(fields.original_start_at!))
    )
      throw new Error("例外日程必须引用可用的原重复日程");
    return parent;
  }

  private encoded(event: CalendarEvent): Record<string, SqlValue> {
    const {
      id,
      created_at,
      updated_at,
      deleted_at,
      device_id,
      deletion_group_id,
      purged_at,
      ...fields
    } = event;
    return {
      id,
      created_at,
      updated_at,
      deleted_at,
      device_id,
      deletion_group_id,
      purged_at,
      ...encodeFields(fields, this.definition.columns),
    };
  }
  private guardedUpdate(current: CalendarEvent, fields: Record<string, SqlValue>): SqlStatement {
    const snapshot = this.encoded(current);
    const where = Object.keys(snapshot)
      .map((key) => (key === "exdates" ? 'json("exdates") = json(?)' : `"${key}" IS ?`))
      .join(" AND ");
    return {
      ...updateStatement("events", fields, where, Object.values(snapshot)),
      expectedRows: 1,
    };
  }
  private async commitChanges(changes: EventChangeSet, originals: CalendarEvent[]): Promise<void> {
    const statements: SqlStatement[] = [];
    const snapshot = new Map(originals.map((event) => [event.id, event]));
    const now = this.context.now();
    const temporaryGroup = this.context.newId();
    // 先暂时软删除要重定位的例外，再在同一事务恢复最终内容，避免交换实例时间时触碰唯一索引。
    for (const event of changes.updated) {
      const current = snapshot.get(event.id);
      if (!current) throw new Error("缺少日程变更前快照");
      if (current.recurrence_id !== null)
        statements.push(
          this.guardedUpdate(current, { deleted_at: now, deletion_group_id: temporaryGroup }),
        );
    }
    for (const event of changes.created) {
      validateEvent(event);
      statements.push({ ...insertStatement("events", this.encoded(event)), expectedRows: 1 });
    }
    for (const event of changes.updated) {
      validateEvent(event);
      const current = snapshot.get(event.id)!;
      const fields = this.encoded(event);
      delete fields.id;
      delete fields.created_at;
      if (current.recurrence_id !== null)
        statements.push({
          ...updateStatement(
            "events",
            fields,
            "id = ? AND deleted_at = ? AND deletion_group_id = ?",
            [event.id, now, temporaryGroup],
          ),
          expectedRows: 1,
        });
      else statements.push(this.guardedUpdate(current, fields));
    }
    const deleted = changes.updated.filter((event) => event.deleted_at !== null);
    for (const event of deleted)
      statements.push(
        updateStatement(
          "reminders",
          {
            deleted_at: event.deleted_at,
            deletion_group_id: event.deletion_group_id,
            updated_at: now,
            device_id: this.context.deviceId,
          },
          "event_id = ? AND deleted_at IS NULL",
          [event.id],
        ),
      );
    for (const event of deleted)
      statements.push(
        updateStatement(
          "reminder_occurrences",
          {
            deleted_at: event.deleted_at,
            deletion_group_id: event.deletion_group_id,
            updated_at: now,
            device_id: this.context.deviceId,
          },
          "reminder_id IN (SELECT id FROM reminders WHERE event_id = ? AND deletion_group_id = ?) AND deleted_at IS NULL",
          [event.id, event.deletion_group_id],
        ),
      );
    const active = [...changes.created, ...changes.updated].filter(
      (event) => event.deleted_at === null,
    );
    const ids = active.map((event) => event.id);
    const linked = ids.length
      ? (
          await this.db.select<SqlRow>(
            `SELECT * FROM reminders WHERE source = 'event' AND deleted_at IS NULL AND event_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, id`,
            ids,
          )
        ).map(reminderDefinition.decode)
      : [];
    for (const event of active)
      statements.push(...eventReminderStatements(event, linked, this.context));
    await this.db.batch(statements);
  }
  private async seriesState(id: string, originalStart: number) {
    const series = await this.requireActive(id);
    const exceptions = await this.read(
      "recurrence_id = ? AND deleted_at IS NULL AND purged_at IS NULL",
      [id],
    );
    if (
      series.exdates.includes(originalStart) &&
      !exceptions.some((event) => event.original_start_at === originalStart)
    )
      throw new Error("此实例已删除，请刷新日程");
    return { series, exceptions };
  }
  async editOccurrence(
    id: string,
    originalStart: number,
    scope: SeriesScope,
    patch: SeriesPatch,
  ): Promise<void> {
    const state = await this.seriesState(id, originalStart);
    const changes = editSeries(state, originalStart, scope, patch, {
      now: this.context.now(),
      deviceId: this.context.deviceId,
      newId: this.context.newId(),
    });
    await this.commitChanges(changes, [state.series, ...state.exceptions]);
  }
  async deleteOccurrence(id: string, originalStart: number, scope: SeriesScope): Promise<void> {
    const state = await this.seriesState(id, originalStart);
    const changes = deleteSeries(state, originalStart, scope, {
      now: this.context.now(),
      deviceId: this.context.deviceId,
      newId: this.context.newId(),
    });
    await this.commitChanges(changes, [state.series, ...state.exceptions]);
  }
  override async softDelete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    const now = this.context.now();
    const group = this.context.newId();
    const fields = {
      deleted_at: now,
      updated_at: now,
      device_id: this.context.deviceId,
      deletion_group_id: group,
    };
    const result = await this.db.batch([
      updateStatement("events", fields, "(id = ? OR recurrence_id = ?) AND deleted_at IS NULL", [
        id,
        id,
      ]),
      updateStatement(
        "reminders",
        fields,
        "event_id IN (SELECT id FROM events WHERE deletion_group_id = ?) AND deleted_at IS NULL",
        [group],
      ),
      updateStatement(
        "reminder_occurrences",
        fields,
        "reminder_id IN (SELECT id FROM reminders WHERE deletion_group_id = ?) AND deleted_at IS NULL",
        [group],
      ),
    ]);
    return (result[0] ?? 0) > 0;
  }
  override async restore(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (!record || record.deleted_at === null) return false;
    if (record.purged_at !== null) throw new Error("内容已永久清空，无法恢复");
    if (record.recurrence_id !== null && !(await this.get(record.recurrence_id)))
      throw new Error("请先恢复原重复日程");
    const fields = {
      deleted_at: null,
      deletion_group_id: null,
      updated_at: this.context.now(),
      device_id: this.context.deviceId,
    };
    const result = await this.db.batch([
      updateStatement(
        "events",
        fields,
        "(id = ? OR recurrence_id = ?) AND deletion_group_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id, id, record.deletion_group_id],
      ),
      updateStatement(
        "reminders",
        fields,
        "event_id IN (SELECT id FROM events WHERE (id = ? OR recurrence_id = ?) AND deleted_at IS NULL AND purged_at IS NULL) AND deletion_group_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id, id, record.deletion_group_id],
      ),
      updateStatement(
        "reminder_occurrences",
        fields,
        "reminder_id IN (SELECT id FROM reminders WHERE event_id IN (SELECT id FROM events WHERE id = ? OR recurrence_id = ?) AND deleted_at IS NULL AND purged_at IS NULL) AND deletion_group_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id, id, record.deletion_group_id],
      ),
    ]);
    return (result[0] ?? 0) > 0;
  }
  override async purgeContent(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (!record || record.purged_at !== null) return false;
    if (record.deleted_at === null) throw new Error("只能清空回收站中的记录");
    const now = this.context.now();
    const result = await this.db.batch([
      updateStatement(
        "reminder_occurrences",
        {
          ...reminderOccurrenceDefinition.cleared,
          purged_at: now,
          updated_at: now,
          device_id: this.context.deviceId,
        },
        "reminder_id IN (SELECT id FROM reminders WHERE event_id IN (SELECT id FROM events WHERE id = ? OR recurrence_id = ?)) AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id, id],
      ),
      updateStatement(
        "reminders",
        {
          ...reminderDefinition.cleared,
          purged_at: now,
          updated_at: now,
          device_id: this.context.deviceId,
        },
        "event_id IN (SELECT id FROM events WHERE id = ? OR recurrence_id = ?) AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id, id],
      ),
      this.purgeStatement("id = ? OR recurrence_id = ?", [id, id], now),
    ]);
    return (result[2] ?? 0) > 0;
  }
}
