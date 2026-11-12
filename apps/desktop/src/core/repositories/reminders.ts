import type { SqlDatabase, SqlStatement } from "../db/database";
import { parseRule } from "../calendar/recurrence";
import { BaseRepository } from "./base-repository";
import type { NewReminder, Reminder, ReminderFields, RepositoryContext } from "./models";
import { reminderDefinition } from "./record-codecs";
import { reminderOccurrenceDefinition } from "./record-codecs";
import { encodeFields, updateStatement } from "./sql-statements";
import { retireReminder } from "./reminder-lifecycle";

export class RemindersRepository extends BaseRepository<Reminder, ReminderFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, reminderDefinition);
  }
  async create(input: NewReminder): Promise<Reminder> {
    const { id, statement } = await this.prepareCreate(input);
    await this.db.batch([statement]);
    return this.requireActive(id);
  }
  async prepareCreate(input: NewReminder) {
    const fields: ReminderFields = {
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
      timezone: "Asia/Shanghai",
      ...input,
      recurrence_start_at: input.due_at ?? null,
      schedule_version: this.context.newId(),
    };
    this.validate(fields);
    await this.validateParent(fields);
    return this.prepareInsert(fields);
  }
  async update(id: string, patch: Partial<ReminderFields>): Promise<Reminder> {
    const current = await this.requireActive(id);
    encodeFields(
      patch,
      this.definition.columns.filter(
        (key) => !["recurrence_start_at", "schedule_version"].includes(key),
      ),
    );
    if (current.source === "event")
      for (const key of [
        "title",
        "notes",
        "due_at",
        "rrule",
        "timezone",
        "event_id",
        "source",
      ] as const)
        if (patch[key] !== undefined && patch[key] !== current[key])
          throw new Error("此提醒由日程生成，请在日程中修改时间和内容");
    const changed = ["due_at", "rrule", "timezone"].some(
      (key) =>
        patch[key as keyof ReminderFields] !== undefined &&
        patch[key as keyof ReminderFields] !== current[key as keyof ReminderFields],
    );
    const schedule = changed
      ? {
          recurrence_start_at: patch.due_at !== undefined ? patch.due_at : current.due_at,
          schedule_version: this.context.newId(),
          completed_at: null,
          notified_at: null,
          snooze_until: null,
        }
      : {};
    const fields = { ...current, ...patch, ...schedule };
    this.validate(fields);
    await this.validateParent(fields);
    const guard = encodeFields(current, Object.keys(current));
    const writes: SqlStatement[] = [
      {
        ...updateStatement(
          "reminders",
          {
            ...encodeFields({ ...patch, ...schedule }, this.definition.columns),
            updated_at: this.context.now(),
            device_id: this.context.deviceId,
          },
          Object.keys(guard)
            .map((key) => `"${key}" IS ?`)
            .join(" AND "),
          Object.values(guard),
        ),
        expectedRows: 1,
      },
    ];
    if (changed)
      writes.push(
        updateStatement(
          "reminder_occurrences",
          {
            deleted_at: this.context.now(),
            updated_at: this.context.now(),
            device_id: this.context.deviceId,
            deletion_group_id: this.context.newId(),
          },
          "reminder_id = ? AND completed_at IS NULL AND deleted_at IS NULL",
          [id],
        ),
      );
    await this.db.batch(writes);
    return this.requireActive(id);
  }
  private validate(fields: ReminderFields): void {
    if (
      typeof fields.title !== "string" ||
      typeof fields.notes !== "string" ||
      !["manual", "event"].includes(fields.source)
    )
      throw new Error("提醒字段无效");
    if (fields.rrule !== null) parseRule(fields.rrule);
    if (fields.rrule !== null && fields.due_at === null) throw new Error("重复提醒需要到期时间");
    try {
      new Intl.DateTimeFormat("en", { timeZone: fields.timezone }).format(0);
    } catch {
      throw new Error("提醒时区无效");
    }
    if (!Number.isInteger(fields.priority) || fields.priority < 0 || fields.priority > 3)
      throw new Error("提醒优先级必须为 0 到 3");
    for (const value of [
      fields.due_at,
      fields.completed_at,
      fields.notified_at,
      fields.snooze_until,
      fields.recurrence_start_at,
    ]) {
      if (value !== null && !Number.isSafeInteger(value))
        throw new Error("提醒时间必须为毫秒时间戳");
    }
    if (fields.source === "event" && fields.event_id === null)
      throw new Error("日程提醒必须关联日程");
  }
  private async validateParent(fields: ReminderFields): Promise<void> {
    if (fields.event_id === null) return;
    const parents = await this.db.select<{ id: string }>(
      "SELECT id FROM events WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL",
      [fields.event_id],
    );
    if (parents.length === 0) throw new Error("关联日程不存在或已删除");
  }
  override async restore(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (!record || record.deleted_at === null) return false;
    if (record.purged_at !== null) throw new Error("内容已永久清空，无法恢复");
    if (record?.event_id) {
      const parents = await this.db.select<{ id: string }>(
        "SELECT id FROM events WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL",
        [record.event_id],
      );
      if (parents.length === 0) throw new Error("请先恢复关联日程");
    }
    const fields = {
      deleted_at: null,
      deletion_group_id: null,
      updated_at: this.context.now(),
      device_id: this.context.deviceId,
    };
    const result = await this.db.batch([
      updateStatement(
        "reminders",
        fields,
        "id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id],
      ),
      updateStatement(
        "reminder_occurrences",
        fields,
        "reminder_id = ? AND deletion_group_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id, record.deletion_group_id],
      ),
    ]);
    return (result[0] ?? 0) > 0;
  }
  override async softDelete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    const result = await this.db.batch(retireReminder(id, this.context));
    return (result[0] ?? 0) > 0;
  }
  override async purgeContent(id: string): Promise<boolean> {
    const row = await this.findAny(id);
    if (!row || row.purged_at !== null) return false;
    if (row.deleted_at === null) throw new Error("只能清空回收站中的记录");
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
        "reminder_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id],
      ),
      this.purgeStatement("id = ?", [id], now),
    ]);
    return (result[1] ?? 0) > 0;
  }
}
