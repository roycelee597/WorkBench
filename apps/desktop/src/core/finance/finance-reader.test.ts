import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { expect, it, vi } from "vitest";
import { FinanceReader } from "./finance-reader";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: vi.fn() } }));

it("按绝对路径只读打开行情缓存，查询后只关闭金融连接池", async () => {
  const path = "C:/Users/Test/AppData/Local/com.royce.workbench/finance.db";
  const url = `sqlite:${path}?mode=ro`;
  vi.mocked(invoke).mockResolvedValueOnce(4096).mockResolvedValueOnce(path);
  const select = vi
    .fn()
    .mockResolvedValueOnce([{ value: "1" }])
    .mockResolvedValueOnce([]);
  const close = vi.fn().mockResolvedValue(true);
  vi.mocked(Database.load).mockResolvedValue({ path: url, select, close } as unknown as Database);
  expect(await new FinanceReader().listIndicators()).toEqual([]);
  expect(Database.load).toHaveBeenCalledWith(url, { autoCreate: false });
  expect(close).toHaveBeenCalledWith(url);
});
