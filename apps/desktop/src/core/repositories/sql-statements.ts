import type { SqlStatement, SqlValue } from "../db/database";

export function encodeFields(fields: object, allowed: string[]): Record<string, SqlValue> {
  const result: Record<string, SqlValue> = {};
  for (const [key, untyped] of Object.entries(fields)) {
    const value: unknown = untyped;
    if (!allowed.includes(key)) throw new Error(`不允许修改字段 ${key}`);
    if (value === undefined) continue;
    if (value === null || typeof value === "string") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = Number(value);
    else if (Array.isArray(value)) result[key] = JSON.stringify(value);
    else throw new Error(`字段 ${key} 无法写入 SQLite`);
  }
  return result;
}

// 表名、字段名和条件均来自仓库自身；外部业务值始终使用占位符绑定。
export function updateStatement(
  table: string,
  fields: Record<string, SqlValue>,
  where: string,
  values: SqlValue[],
): SqlStatement {
  const keys = Object.keys(fields);
  return {
    query: `UPDATE "${table}" SET ${keys.map((key) => `"${key}" = ?`).join(", ")} WHERE ${where}`,
    values: [...Object.values(fields), ...values],
  };
}
export function insertStatement(
  table: string,
  fields: Record<string, SqlValue>,
  guard?: { where: string; values: SqlValue[] },
): SqlStatement {
  const keys = Object.keys(fields);
  const placeholders = keys.map(() => "?").join(", ");
  return {
    query: `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(", ")}) ${guard ? `SELECT ${placeholders} WHERE ${guard.where}` : `VALUES (${placeholders})`}`,
    values: [...Object.values(fields), ...(guard?.values ?? [])],
  };
}
