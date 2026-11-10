import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { z } from "zod";

const indicatorSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  group: z.string(),
  order: z.number(),
  series: z.array(z.looseObject({ key: z.string(), label: z.string() })),
});

export type IndicatorMeta = z.infer<typeof indicatorSchema>;
export type DateRange = { from: number; to: number };
export type SeriesData = {
  key: string;
  points: { trade_date: number; value: number | null; extra_json: string | null }[];
};

type DatasetStatus = {
  dataset: string;
  status: "ok" | "pending" | "error" | "empty";
  days: number;
  through: number;
};
export type FinanceStatus = {
  bytes: number;
  firstDate: number | null;
  latestDate: number | null;
  datasets: DatasetStatus[];
  lastRun: { status: string; finished_at: number | null; error_message: string | null } | null;
};

const emptyStatus: FinanceStatus = {
  bytes: 0,
  firstDate: null,
  latestDate: null,
  datasets: [],
  lastRun: null,
};

export class FinanceReader {
  private pending: Promise<void> = Promise.resolve();
  private rebuilding = false;

  async suspendForRebuild(): Promise<void> {
    this.rebuilding = true;
    await this.pending;
  }

  resume(): void {
    this.rebuilding = false;
  }

  private read<T>(empty: T, query: (db: Database, bytes: number) => Promise<T>): Promise<T> {
    if (this.rebuilding) return Promise.resolve(empty);
    const operation = this.pending.then(async () => {
      const bytes = await invoke<number | null>("finance_db_size");
      if (bytes === null) return empty;
      const path = await invoke<string>("finance_db_path");
      const url = `sqlite:${path.replaceAll("%", "%25").replaceAll("\\", "/")}?mode=ro`;
      const db = await Database.load(url, { autoCreate: false });
      try {
        const [schema] = await db.select<{ value: string }[]>(
          "SELECT value FROM meta WHERE key='schema_version'",
        );
        if (schema?.value !== "1") throw new Error("金融缓存版本不兼容，请重建金融数据");
        return await query(db, bytes);
      } finally {
        // 省略参数会关闭插件的所有连接池，包括综合工作台的 workbench.db。
        await db.close(db.path);
      }
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  listIndicators(): Promise<IndicatorMeta[]> {
    return this.read<IndicatorMeta[]>([], async (db) => {
      const rows = await db.select<{ meta_json: string }[]>("SELECT meta_json FROM indicator_meta");
      return rows
        .map((row) => indicatorSchema.parse(JSON.parse(row.meta_json)))
        .sort((a, b) => a.order - b.order);
    });
  }

  getSeries(keys: string[], range?: DateRange): Promise<SeriesData[]> {
    if (!keys.length) return Promise.resolve([]);
    return this.read<SeriesData[]>(
      keys.map((key) => ({ key, points: [] })),
      async (db) => {
        const params: (string | number)[] = [...keys];
        if (range) params.push(range.from, range.to);
        const rows = await db.select<(SeriesData["points"][number] & { series_key: string })[]>(
          `SELECT series_key,trade_date,value,extra_json FROM indicator_values
         WHERE series_key IN (${keys.map(() => "?").join(",")})
         ${range ? "AND trade_date BETWEEN ? AND ?" : ""} ORDER BY trade_date`,
          params,
        );
        const points = new Map<string, SeriesData["points"]>(keys.map((key) => [key, []]));
        for (const { series_key, ...point } of rows) points.get(series_key)?.push(point);
        return Array.from(points, ([key, points]) => ({ key, points }));
      },
    );
  }

  getStatus(): Promise<FinanceStatus> {
    return this.read(emptyStatus, async (db, bytes) => {
      const [bounds] = await db.select<{ firstDate: number | null; latestDate: number | null }[]>(
        "SELECT min(trade_date) AS firstDate,max(trade_date) AS latestDate FROM indicator_values WHERE value IS NOT NULL",
      );
      const datasets = await db.select<DatasetStatus[]>(
        "SELECT dataset,status,count(*) AS days,max(trade_date) AS through FROM dataset_status GROUP BY dataset,status",
      );
      const [lastRun] = await db.select<NonNullable<FinanceStatus["lastRun"]>[]>(
        "SELECT status,finished_at,error_message FROM run_log ORDER BY started_at DESC LIMIT 1",
      );
      return {
        bytes,
        firstDate: bounds?.firstDate ?? null,
        latestDate: bounds?.latestDate ?? null,
        datasets,
        lastRun: lastRun ?? null,
      };
    });
  }
}
