import { z } from "zod";
import type { SqlDatabase, SqlStatement } from "../db/database";
import type { IndicatorMeta } from "../finance/finance-reader";
import { BaseRepository } from "./base-repository";
import type { RecordMetadata, RepositoryContext } from "./models";
import { metadata, nullableText, number, text, type RecordDefinition } from "./record-codecs";
import { encodeFields, updateStatement } from "./sql-statements";

const direction = z.enum(["above", "below"]);
const input = z
  .object({
    indicator_id: z.string().min(1),
    series_key: z.string().min(1),
    direction,
    level: z.number(),
    hysteresis: z.number().nonnegative(),
    enabled: z.boolean(),
    label: z.string().trim(),
  })
  .strict();

export type ThresholdInput = z.infer<typeof input>;
type ThresholdFields = ThresholdInput & { default_key: string | null };
export type FinanceThreshold = RecordMetadata & ThresholdFields;

const definition: RecordDefinition<FinanceThreshold> = {
  table: "finance_thresholds",
  columns: [...Object.keys(input.shape), "default_key"],
  order: "created_at, id",
  cleared: { label: "" },
  decode: (row) => ({
    ...metadata(row),
    indicator_id: text(row, "indicator_id"),
    series_key: text(row, "series_key"),
    direction: direction.parse(row.direction),
    level: number(row, "level"),
    hysteresis: number(row, "hysteresis"),
    enabled: number(row, "enabled") === 1,
    label: text(row, "label"),
    default_key: nullableText(row, "default_key"),
  }),
};

export class FinanceThresholdsRepository extends BaseRepository<FinanceThreshold, ThresholdFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, definition);
  }

  create(fields: ThresholdInput) {
    return this.insert({ ...input.parse(fields), default_key: null });
  }

  async update(id: string, fields: ThresholdInput) {
    const current = await this.requireActive(id);
    const next = input.parse(fields);
    const changed = Object.keys(next).filter(
      (key) => current[key as keyof ThresholdInput] !== next[key as keyof ThresholdInput],
    );
    if (changed.length === 0) return current;
    const version = Math.max(this.context.now(), current.updated_at + 1);
    const statements: SqlStatement[] = [
      {
        ...updateStatement(
          "finance_thresholds",
          {
            ...encodeFields(next, definition.columns),
            updated_at: version,
            device_id: this.context.deviceId,
          },
          "id = ? AND updated_at = ? AND deleted_at IS NULL",
          [id, current.updated_at],
        ),
        expectedRows: 1,
      },
    ];
    if (changed.length === 1 && changed[0] === "label") {
      // 改备注不会重置回差状态，但状态版本需要与阈值版本一致。
      statements.push({
        query: `UPDATE finance_alert_states SET threshold_version = ?, device_id = ?,
          updated_at = max(?, updated_at + 1)
          WHERE threshold_id = ? AND threshold_version = ? AND deleted_at IS NULL`,
        values: [version, this.context.deviceId, version, id, current.updated_at],
      });
    }
    await this.db.batch(statements);
    return this.requireActive(id);
  }

  async ensureDefaults(indicators: readonly IndicatorMeta[]) {
    // 包括墓碑，防止用户删除的默认项重新出现。
    const known = new Set(
      (
        await this.db.select<{ default_key: string }>(
          "SELECT default_key FROM finance_thresholds WHERE default_key IS NOT NULL",
        )
      ).map(({ default_key }) => default_key),
    );
    const statements = indicators.flatMap((indicator) =>
      (indicator.default_thresholds ?? []).flatMap((item) => {
        if (!item.default_key || item.hysteresis === undefined || known.has(item.default_key))
          return [];
        known.add(item.default_key);
        const { statement } = this.prepareInsert({
          ...item,
          indicator_id: indicator.id,
          default_key: item.default_key,
          hysteresis: item.hysteresis,
          enabled: true,
        });
        return {
          ...statement,
          query:
            statement.query + " ON CONFLICT(default_key) WHERE default_key IS NOT NULL DO NOTHING",
        };
      }),
    );
    if (statements.length) await this.db.batch(statements);
  }

  override async softDelete(id: string) {
    const now = this.context.now();
    const fields = {
      deleted_at: now,
      updated_at: now,
      deletion_group_id: this.context.newId(),
      device_id: this.context.deviceId,
    };
    const [deleted] = await this.db.batch([
      updateStatement("finance_thresholds", fields, "id = ? AND deleted_at IS NULL", [id]),
      updateStatement("finance_alert_states", fields, "threshold_id = ? AND deleted_at IS NULL", [
        id,
      ]),
    ]);
    return deleted === 1;
  }
}
