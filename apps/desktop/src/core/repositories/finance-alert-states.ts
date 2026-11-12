import { z } from "zod";
import type { SqlDatabase, SqlStatement } from "../db/database";
import { FINANCE_WORKBENCH, type FinanceTarget } from "../finance/finance-target";
import { BaseRepository } from "./base-repository";
import type { RecordMetadata, RepositoryContext } from "./models";
import {
  metadata,
  nullableNumber,
  nullableText,
  number,
  text,
  type RecordDefinition,
} from "./record-codecs";
import { encodeFields, insertStatement, updateStatement } from "./sql-statements";

export type AlertStateFields = {
  threshold_id: string;
  threshold_version: number;
  breached: boolean;
  evaluated_through: number;
  last_crossed_date: number | null;
  last_reminder_id: string | null;
};
export type FinanceAlertState = RecordMetadata & AlertStateFields;

const definition: RecordDefinition<FinanceAlertState> = {
  table: "finance_alert_states",
  columns: [
    "threshold_id",
    "threshold_version",
    "breached",
    "evaluated_through",
    "last_crossed_date",
    "last_reminder_id",
  ],
  order: "threshold_id",
  cleared: {},
  decode: (row) => ({
    ...metadata(row),
    threshold_id: text(row, "threshold_id"),
    threshold_version: number(row, "threshold_version"),
    breached: number(row, "breached") === 1,
    evaluated_through: number(row, "evaluated_through"),
    last_crossed_date: nullableNumber(row, "last_crossed_date"),
    last_reminder_id: nullableText(row, "last_reminder_id"),
  }),
};

const targetSchema = z.object({ indicatorId: z.string().min(1), seriesKey: z.string().min(1) });
const thresholdGuard = `EXISTS (
  SELECT 1 FROM finance_thresholds WHERE id = ? AND updated_at = ? AND deleted_at IS NULL AND enabled = 1
)`;

export class FinanceAlertStatesRepository extends BaseRepository<
  FinanceAlertState,
  AlertStateFields
> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, definition);
  }

  async targetForReminder(id: string): Promise<FinanceTarget | null> {
    const [row] = await this.db.select<{ value: string }>(
      "SELECT value FROM workbench_kv WHERE workbench_id = ? AND key = ? AND deleted_at IS NULL",
      [FINANCE_WORKBENCH, "reminder:" + id],
    );
    return row ? targetSchema.parse(JSON.parse(row.value)) : null;
  }

  async commit(
    updates: readonly { next: AlertStateFields; previous: FinanceAlertState | undefined }[],
    reminders: readonly { id: string; statement: SqlStatement; target: FinanceTarget }[],
  ) {
    const now = this.context.now();
    const writes = reminders.flatMap(({ id, statement, target }) => [
      statement,
      insertStatement("workbench_kv", {
        id: this.context.newId(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
        device_id: this.context.deviceId,
        workbench_id: FINANCE_WORKBENCH,
        key: "reminder:" + id,
        value: JSON.stringify(target),
      }),
    ]);
    for (const { next, previous } of updates) {
      const guard = [next.threshold_id, next.threshold_version];
      if (previous) {
        writes.push({
          ...updateStatement(
            definition.table,
            {
              ...encodeFields(next, definition.columns),
              updated_at: Math.max(now, previous.updated_at + 1),
              device_id: this.context.deviceId,
            },
            `id = ? AND updated_at = ? AND deleted_at IS NULL AND ${thresholdGuard}`,
            [previous.id, previous.updated_at, ...guard],
          ),
          expectedRows: 1,
        });
      } else {
        const { statement } = this.prepareInsert(next, { where: thresholdGuard, values: guard });
        writes.push({ ...statement, expectedRows: 1 });
      }
    }
    if (writes.length) await this.db.batch(writes);
  }
}
