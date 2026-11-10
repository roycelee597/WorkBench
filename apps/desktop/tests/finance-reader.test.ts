import { invoke } from "@tauri-apps/api/core";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { FinanceReader } from "../src/core/finance/finance-reader";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { select, database } = vi.hoisted(() => {
  const select = vi.fn();
  return {
    select,
    database: vi.fn(function () {
      return { select };
    }),
  };
});

it("较前一交易日只取紧邻的开市日，不跨越空日比较", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE trade_calendar (cal_date INTEGER, is_open INTEGER);
      INSERT INTO trade_calendar VALUES (20261104,1), (20261105,1), (20261106,1);
      CREATE TABLE indicator_values (series_key TEXT, trade_date INTEGER, value REAL, extra_json TEXT);
      INSERT INTO indicator_values VALUES
        ('skipped',20261104,32,NULL), ('skipped',20261106,42,NULL),
        ('empty',20261105,NULL,NULL), ('empty',20261106,10,NULL);`);
    vi.mocked(invoke).mockResolvedValueOnce({ key: "sqlite:finance-read-only", bytes: 4096 });
    select.mockImplementation(async (query: string, values: (string | number)[] = []) =>
      db.prepare(query).all(...values),
    );
    const recent = await new FinanceReader().getRecent(["skipped", "empty"]);
    expect(recent).toEqual([
      { key: "skipped", points: [{ trade_date: 20261106, value: 42, extra_json: null }] },
      {
        key: "empty",
        points: [
          { trade_date: 20261105, value: null, extra_json: null },
          { trade_date: 20261106, value: 10, extra_json: null },
        ],
      },
    ]);
  } finally {
    select.mockReset();
    db.close();
  }
});
vi.mock("@tauri-apps/plugin-sql", () => ({ default: database }));

it("使用原生固定路径连接，不向 SQL 插件提交文件路径", async () => {
  const key = "sqlite:finance-read-only";
  vi.mocked(invoke).mockResolvedValueOnce({ key, bytes: 4096 });
  select.mockResolvedValueOnce([{ value: "1" }]).mockResolvedValueOnce([]);
  expect(await new FinanceReader().listIndicators()).toEqual([]);
  expect(database).toHaveBeenCalledWith(key);
  expect(invoke).toHaveBeenNthCalledWith(1, "finance_reader_open");
  expect(invoke).toHaveBeenNthCalledWith(2, "finance_reader_close");
});
