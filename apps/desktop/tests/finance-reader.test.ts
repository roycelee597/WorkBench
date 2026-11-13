import { invoke } from "@tauri-apps/api/core";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
vi.mock("@tauri-apps/plugin-sql", () => ({ default: database }));

let cache: DatabaseSync | undefined;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  select.mockReset();
  database.mockClear();
});

afterEach(() => {
  cache?.close();
  cache = undefined;
});

function setCache(rows: string) {
  const db = new DatabaseSync(":memory:");
  cache = db;
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE trade_calendar (cal_date INTEGER PRIMARY KEY, is_open INTEGER);
    CREATE TABLE indicator_values (
      series_key TEXT, trade_date INTEGER, value REAL, extra_json TEXT,
      PRIMARY KEY (series_key, trade_date)
    ) WITHOUT ROWID;
    ${rows}`);
  vi.mocked(invoke).mockResolvedValueOnce({ key: "sqlite:finance-read-only", bytes: 4096 });
  select.mockImplementation(async (query: string, values: (string | number)[] = []) =>
    db.prepare(query).all(...values),
  );
}

it("较前一交易日只取紧邻的开市日，不跨越空日比较", async () => {
  setCache(`INSERT INTO trade_calendar VALUES (20261104,1), (20261105,1), (20261106,1);
    INSERT INTO indicator_values VALUES
      ('skipped',20261104,32,NULL), ('skipped',20261106,42,NULL),
      ('empty',20261105,NULL,NULL), ('empty',20261106,10,NULL);`);
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
});

it("只在各序列覆盖区间补开市日，保留显式空值与附加字段", async () => {
  setCache(`INSERT INTO trade_calendar VALUES (20261105,1), (20261106,1),
    (20261107,0), (20261108,0), (20261109,1), (20261110,1), (20261111,1), (20261112,1);
    INSERT INTO indicator_values VALUES
      ('share',20261106,42,NULL), ('share',20261110,NULL,'{"reason":"pending"}'),
      ('share',20261111,0,NULL), ('single',20261110,8,NULL);`);

  expect(await new FinanceReader().getSeries(["share", "single", "missing"])).toEqual([
    {
      key: "share",
      points: [
        { trade_date: 20261106, value: 42, extra_json: null },
        { trade_date: 20261109, value: null, extra_json: null },
        { trade_date: 20261110, value: null, extra_json: '{"reason":"pending"}' },
        { trade_date: 20261111, value: 0, extra_json: null },
      ],
    },
    { key: "single", points: [{ trade_date: 20261110, value: 8, extra_json: null }] },
    { key: "missing", points: [] },
  ]);
});

it("查询范围只有缺失交易日时仍返回空点", async () => {
  setCache(`INSERT INTO trade_calendar VALUES (20261106,1), (20261109,1), (20261110,1);
    INSERT INTO indicator_values VALUES ('share',20261106,42,NULL), ('share',20261110,44,NULL);`);

  expect(await new FinanceReader().getSeries(["share"], { from: 20261109, to: 20261109 })).toEqual([
    { key: "share", points: [{ trade_date: 20261109, value: null, extra_json: null }] },
  ]);
});

it("沪深300按自身覆盖区间补开市日，忽略休市日和其他指数", async () => {
  setCache(`CREATE TABLE index_daily (
      ts_code TEXT, trade_date INTEGER, close REAL, source TEXT DEFAULT 'tushare', PRIMARY KEY (ts_code, trade_date)
    ) WITHOUT ROWID;
    INSERT INTO trade_calendar VALUES (20261105,1), (20261106,1), (20261107,0),
      (20261108,0), (20261109,1), (20261110,1), (20261111,1);
    INSERT INTO index_daily (ts_code,trade_date,close) VALUES
      ('000300.SH',20261106,4500), ('000300.SH',20261110,4550),
      ('000001.SH',20261105,3800), ('000001.SH',20261109,3900), ('000001.SH',20261111,4000);`);

  expect(await new FinanceReader().getOverlay()).toEqual([
    { trade_date: 20261106, value: 4500, extra_json: null },
    { trade_date: 20261109, value: null, extra_json: null },
    { trade_date: 20261110, value: 4550, extra_json: null },
  ]);
});

it("使用原生固定路径连接，不向 SQL 插件提交文件路径", async () => {
  const key = "sqlite:finance-read-only";
  vi.mocked(invoke).mockResolvedValueOnce({ key, bytes: 4096 });
  select.mockResolvedValueOnce([{ value: "1" }]).mockResolvedValueOnce([]);
  expect(await new FinanceReader().listIndicators()).toEqual([]);
  expect(database).toHaveBeenCalledWith(key);
  expect(invoke).toHaveBeenNthCalledWith(1, "finance_reader_open");
  expect(invoke).toHaveBeenNthCalledWith(2, "finance_reader_close");
});

it("沪深300备用来源随有效点读取，空开市日不伪造来源", async () => {
  setCache(`CREATE TABLE index_daily (
      ts_code TEXT, trade_date INTEGER, close REAL, source TEXT,
      PRIMARY KEY (ts_code,trade_date));
    INSERT INTO trade_calendar VALUES (20261111,1),(20261112,1),(20261113,1);
    INSERT INTO index_daily VALUES
      ('000300.SH',20261111,4500,'tushare'),('000300.SH',20261113,4520,'akshare');`);
  expect(await new FinanceReader().getOverlay()).toEqual([
    { trade_date: 20261111, value: 4500, extra_json: null },
    { trade_date: 20261112, value: null, extra_json: null },
    { trade_date: 20261113, value: 4520, extra_json: '{"source":"akshare"}' },
  ]);
});
