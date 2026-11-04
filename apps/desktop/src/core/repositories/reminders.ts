import type { SqlDatabase } from "../db/database";
import { parseRule } from "../calendar/recurrence";
import { BaseRepository } from "./base-repository";
import type { NewReminder, Reminder, ReminderFields, RepositoryContext } from "./models";
import { reminderDefinition } from "./record-codecs";

export class RemindersRepository extends BaseRepository<Reminder, ReminderFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, reminderDefinition);
  }
  async create(input: NewReminder): Promise<Reminder> {
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
      ...input,
    };
    this.validate(fields);
    await this.validateParent(fields);
    return this.insert(fields);
  }
  async update(id: string, patch: Partial<ReminderFields>): Promise<Reminder> {
    const current = await this.requireActive(id);
    const fields = { ...current, ...patch };
    this.validate(fields);
    await this.validateParent(fields);
    return this.writePatch(id, patch);
  }
  private validate(fields: ReminderFields): void {
    if (
      typeof fields.title !== "string" ||
      typeof fields.notes !== "string" ||
      !["manual", "event"].includes(fields.source)
    )
      throw new Error("提醒字段无效");
    if (fields.rrule !== null) parseRule(fields.rrule);
    if (!Number.isInteger(fields.priority) || fields.priority < 0 || fields.priority > 3)
      throw new Error("提醒优先级必须为 0 到 3");
    for (const value of [
      fields.due_at,
      fields.completed_at,
      fields.notified_at,
      fields.snooze_until,
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
    if (record?.event_id) {
      const parents = await this.db.select<{ id: string }>(
        "SELECT id FROM events WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL",
        [record.event_id],
      );
      if (parents.length === 0) throw new Error("请先恢复关联日程");
    }
    return super.restore(id);
  }
}
