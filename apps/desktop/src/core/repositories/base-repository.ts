import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "../db/database";
import type { RecordMetadata, RepositoryContext } from "./models";
import type { RecordDefinition } from "./record-codecs";
import { encodeFields, insertStatement, updateStatement } from "./sql-statements";

export class BaseRepository<T extends RecordMetadata, Fields extends object> {
  constructor(
    protected readonly db: SqlDatabase,
    protected readonly context: RepositoryContext,
    protected readonly definition: RecordDefinition<T>,
  ) {}

  async list(): Promise<T[]> {
    return this.read(`deleted_at IS NULL AND purged_at IS NULL`, [], this.definition.order);
  }
  async get(id: string): Promise<T | null> {
    return (
      (await this.read("id = ? AND deleted_at IS NULL AND purged_at IS NULL", [id]))[0] ?? null
    );
  }
  async listDeleted(): Promise<T[]> {
    return this.read("deleted_at IS NOT NULL AND purged_at IS NULL", [], "deleted_at DESC, id");
  }
  protected async read(where: string, values: SqlValue[], order = "id"): Promise<T[]> {
    const rows = await this.db.select<SqlRow>(
      `SELECT * FROM "${this.definition.table}" WHERE ${where} ORDER BY ${order}`,
      values,
    );
    return rows.map(this.definition.decode);
  }
  protected async findAny(id: string): Promise<T | null> {
    return (await this.read("id = ?", [id]))[0] ?? null;
  }
  protected async requireActive(id: string): Promise<T> {
    const record = await this.get(id);
    if (!record) throw new Error("记录不存在或已删除");
    return record;
  }
  protected prepareInsert(
    fields: Fields,
    guard?: Parameters<typeof insertStatement>[2],
  ): { id: string; statement: SqlStatement } {
    const now = this.context.now();
    const id = this.context.newId();
    return {
      id,
      statement: insertStatement(
        this.definition.table,
        {
          id,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          device_id: this.context.deviceId,
          deletion_group_id: null,
          purged_at: null,
          ...encodeFields(fields, this.definition.columns),
        },
        guard,
      ),
    };
  }
  protected async insert(fields: Fields): Promise<T> {
    const { id, statement } = this.prepareInsert(fields);
    await this.db.batch([statement]);
    return this.requireActive(id);
  }
  protected async writePatch(id: string, fields: Partial<Fields>): Promise<T> {
    const values = encodeFields(fields, this.definition.columns);
    if (Object.keys(values).length > 0) {
      await this.db.batch([
        updateStatement(
          this.definition.table,
          { ...values, updated_at: this.context.now(), device_id: this.context.deviceId },
          "id = ? AND deleted_at IS NULL AND purged_at IS NULL",
          [id],
        ),
      ]);
    }
    return this.requireActive(id);
  }
  async softDelete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    const now = this.context.now();
    const result = await this.db.batch([
      updateStatement(
        this.definition.table,
        {
          deleted_at: now,
          updated_at: now,
          device_id: this.context.deviceId,
          deletion_group_id: this.context.newId(),
        },
        "id = ? AND deleted_at IS NULL",
        [id],
      ),
    ]);
    return (result[0] ?? 0) > 0;
  }
  async restore(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (!record || record.deleted_at === null) return false;
    if (record.purged_at !== null) throw new Error("内容已永久清空，无法恢复");
    const result = await this.db.batch([
      updateStatement(
        this.definition.table,
        {
          deleted_at: null,
          deletion_group_id: null,
          updated_at: this.context.now(),
          device_id: this.context.deviceId,
        },
        "id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL",
        [id],
      ),
    ]);
    return (result[0] ?? 0) > 0;
  }
  purgeStatement(where: string, values: SqlValue[], now: number): SqlStatement {
    return updateStatement(
      this.definition.table,
      {
        ...this.definition.cleared,
        purged_at: now,
        updated_at: now,
        device_id: this.context.deviceId,
      },
      `deleted_at IS NOT NULL AND purged_at IS NULL AND (${where})`,
      values,
    );
  }
  async purgeContent(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (!record || record.purged_at !== null) return false;
    if (record.deleted_at === null) throw new Error("只能清空回收站中的记录");
    const result = await this.db.batch([this.purgeStatement("id = ?", [id], this.context.now())]);
    return (result[0] ?? 0) > 0;
  }
}
