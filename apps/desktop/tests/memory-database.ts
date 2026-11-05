import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL as NodeURL } from "node:url";
import type { SqlDatabase, SqlStatement, SqlValue } from "../src/core/db/database";
import { createDataLayer } from "../src/core/repositories";

// 执行与桌面端相同的迁移和 SQL；只把插件连接替换成真正的内存 SQLite。
export class MemoryDatabase implements SqlDatabase {
  readonly connection = new DatabaseSync(":memory:");
  failAt: number | null = null;
  constructor() {
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec(
      readFileSync(new NodeURL("../src-tauri/migrations/0001_init.sql", import.meta.url), "utf8"),
    );
  }
  async select<T>(query: string, values: SqlValue[] = []): Promise<T[]> {
    return this.connection.prepare(query).all(...values) as T[];
  }
  async batch(statements: SqlStatement[]): Promise<number[]> {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error("模拟事务失败");
        const changed = Number(
          this.connection.prepare(statement.query).run(...statement.values).changes,
        );
        if (statement.expectedRows !== undefined && changed !== statement.expectedRows)
          throw new Error("内容已发生变化，请刷新后重试");
        return changed;
      });
      this.connection.exec("COMMIT");
      return results;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.connection.close();
  }
}

export async function fixture() {
  const db = new MemoryDatabase();
  const clock = { now: Date.parse("2026-06-01T00:00:00Z") };
  const data = await createDataLayer(db, { now: () => clock.now });
  return { db, clock, data };
}
