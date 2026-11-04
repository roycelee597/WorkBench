import { parseRule } from "../calendar/recurrence";
import type { SqlDatabase } from "../db/database";
import { BaseRepository } from "./base-repository";
import type { CalendarEvent, EventFields, NewEvent, RepositoryContext } from "./models";
import { eventDefinition, reminderDefinition } from "./record-codecs";
import { updateStatement } from "./sql-statements";

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
    await this.validateParent(fields);
    return this.insert(fields);
  }
  async update(id: string, patch: Partial<EventFields>): Promise<CalendarEvent> {
    const current = await this.requireActive(id);
    const fields = { ...current, ...patch };
    validateEvent(fields);
    if (fields.recurrence_id === id) throw new Error("日程不能引用自身");
    await this.validateParent(fields);
    return this.writePatch(id, patch);
  }
  private async validateParent(fields: EventFields): Promise<void> {
    if (fields.recurrence_id === null) return;
    const parent = await this.get(fields.recurrence_id);
    if (
      !parent ||
      parent.recurrence_id !== null ||
      (parent.rrule === null && !parent.exdates.includes(fields.original_start_at!))
    )
      throw new Error("例外日程必须引用可用的原重复日程");
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
    return (result[1] ?? 0) > 0;
  }
}
