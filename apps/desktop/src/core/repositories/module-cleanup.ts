import type { SqlDatabase, SqlStatement } from "../db/database";
import type { RepositoryContext } from "./models";
import {
  eventDefinition,
  memoDefinition,
  reminderDefinition,
  reminderOccurrenceDefinition,
} from "./record-codecs";
import { updateStatement } from "./sql-statements";

export class ModuleCleanupRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly context: RepositoryContext,
  ) {}

  async purgeSharedData(moduleId: string): Promise<void> {
    if (moduleId === "com.royce.workbench.general" || moduleId === "general")
      throw new Error("综合工作台不可卸载");
    const now = this.context.now();
    const group = this.context.newId();
    const reminders = `(source_workbench = ? OR (source = 'event' AND event_id IN (
      SELECT id FROM events WHERE source_workbench = ?
    )))`;
    const records = [
      {
        definition: reminderOccurrenceDefinition,
        where: `reminder_id IN (SELECT id FROM reminders WHERE ${reminders})`,
        params: [moduleId, moduleId],
      },
      { definition: reminderDefinition, where: reminders, params: [moduleId, moduleId] },
      { definition: eventDefinition, where: "source_workbench = ?", params: [moduleId] },
      { definition: memoDefinition, where: "source_workbench = ?", params: [moduleId] },
    ];
    const statements: SqlStatement[] = [];
    for (const { definition, where, params } of records) {
      // 先补齐同步墓碑，再清空内容和来源。整个过程共用事务，可重复执行。
      statements.push(
        updateStatement(
          definition.table,
          { deleted_at: now, deletion_group_id: group },
          `deleted_at IS NULL AND purged_at IS NULL AND (${where})`,
          params,
        ),
        updateStatement(
          definition.table,
          {
            ...definition.cleared,
            purged_at: now,
            updated_at: now,
            device_id: this.context.deviceId,
          },
          `deleted_at IS NOT NULL AND purged_at IS NULL AND (${where})`,
          params,
        ),
      );
    }
    await this.db.batch(statements);
  }
}
