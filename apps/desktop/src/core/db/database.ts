import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement {
  query: string;
  values: SqlValue[];
}

export interface SqlDatabase {
  select<T>(query: string, values?: SqlValue[]): Promise<T[]>;
  batch(statements: SqlStatement[]): Promise<number[]>;
}

export const DATABASE_URL = "sqlite:workbench.db";

export function openDatabase(): SqlDatabase {
  // 原生端已在启动时预加载数据库并执行迁移，无须重复 load。
  const database = Database.get(DATABASE_URL);
  return {
    select: <T>(query: string, values: SqlValue[] = []) => database.select<T[]>(query, values),
    batch: (statements) => invoke<number[]>("execute_batch", { statements }),
  };
}
