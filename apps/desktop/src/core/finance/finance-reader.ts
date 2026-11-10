import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { z } from "zod";

const metricSchema = z.enum(["pe_ttm", "pb"]);
const windowSchema = z.enum(["5y", "10y", "all"]);
const viewSchema = z.enum(["percentile", "raw"]);

const indicatorSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  group: z.string(),
  order: z.number(),
  unit: z.string().optional(),
  decimals: z.int().min(0).max(6).optional(),
  series: z.array(
    z.looseObject({
      key: z.string(),
      label: z.string(),
      primary: z.boolean().optional(),
      index: z.string().optional(),
      metric: metricSchema.optional(),
      window: z.enum(["raw", "pct_5y", "pct_10y", "pct_all"]).optional(),
    }),
  ),
  views: z
    .object({ monthly_avg: z.boolean().optional(), overlay_hs300: z.boolean().optional() })
    .optional(),
  dimensions: z
    .object({
      indices: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
      metrics: z.array(metricSchema).min(1),
      windows: z.array(windowSchema).min(1),
      views: z.array(viewSchema).min(1),
      default_metric: metricSchema.optional(),
      default_window: windowSchema.optional(),
      default_view: viewSchema.optional(),
    })
    .optional(),
  default_thresholds: z
    .array(
      z.object({
        series_key: z.string(),
        level: z.number(),
        label: z.string(),
        direction: z.enum(["above", "below"]),
      }),
    )
    .optional(),
  description_md: z.string().optional(),
});

export type IndicatorMeta = z.infer<typeof indicatorSchema>;
export type ValuationMetric = z.infer<typeof metricSchema>;
export type ValuationWindow = z.infer<typeof windowSchema>;
export type ValuationView = z.infer<typeof viewSchema>;
export type DateRange = { from: number; to: number };
export type SeriesData = {
  key: string;
  points: { trade_date: number; value: number | null; extra_json: string | null }[];
};
export type FinancePoint = SeriesData["points"][number];

type SeriesRow = FinancePoint & { series_key: string };

function groupSeries(keys: string[], rows: SeriesRow[]): SeriesData[] {
  const points = new Map<string, FinancePoint[]>(keys.map((key) => [key, []]));
  for (const { series_key, ...point } of rows) points.get(series_key)?.push(point);
  return Array.from(points, ([key, points]) => ({ key, points }));
}

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
      const cache = await invoke<{ key: string; bytes: number } | null>("finance_reader_open");
      if (!cache) return empty;
      const db = new Database(cache.key);
      try {
        const [schema] = await db.select<{ value: string }[]>(
          "SELECT value FROM meta WHERE key='schema_version'",
        );
        if (schema?.value !== "1") throw new Error("金融缓存版本不兼容，请重建金融数据");
        return await query(db, cache.bytes);
      } finally {
        await invoke("finance_reader_close");
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
        const params: (string | number)[] = [JSON.stringify(keys)];
        if (range) params.push(range.from, range.to);
        // 以每条序列已写入的首尾记录为边界，即使请求的范围内全是缺行也要返回开市日。
        const rows = await db.select<SeriesRow[]>(
          `WITH selected AS (
            SELECT value AS series_key FROM json_each(?1)
          ), bounds AS (
            SELECT series_key,
              (SELECT min(trade_date) FROM indicator_values WHERE series_key=s.series_key) AS first_date,
              (SELECT max(trade_date) FROM indicator_values WHERE series_key=s.series_key) AS last_date
            FROM selected AS s
          ), days AS (
            SELECT series_key,trade_date FROM indicator_values
            WHERE series_key IN (SELECT series_key FROM selected)
              ${range ? "AND trade_date BETWEEN ?2 AND ?3" : ""}
            UNION
            SELECT b.series_key,c.cal_date FROM bounds AS b JOIN trade_calendar AS c
              ON c.cal_date BETWEEN b.first_date AND b.last_date
            WHERE c.is_open=1 ${range ? "AND c.cal_date BETWEEN ?2 AND ?3" : ""}
          )
          SELECT d.series_key,d.trade_date,v.value,v.extra_json FROM days AS d
          LEFT JOIN indicator_values AS v USING (series_key,trade_date)
          ORDER BY d.trade_date`,
          params,
        );
        return groupSeries(keys, rows);
      },
    );
  }

  getRecent(keys: string[]): Promise<SeriesData[]> {
    if (!keys.length) return Promise.resolve([]);
    return this.read<SeriesData[]>([], async (db) => {
      const rows = await db.select<SeriesRow[]>(
        `WITH selected AS (
        SELECT key.value AS series_key, (
          SELECT max(trade_date) FROM indicator_values WHERE series_key=key.value AND value IS NOT NULL
        ) AS latest FROM json_each(?) AS key
      ) SELECT v.series_key,v.trade_date,v.value,v.extra_json
        FROM selected AS s JOIN indicator_values AS v ON v.series_key=s.series_key
        AND v.trade_date IN (s.latest, (
          SELECT max(cal_date) FROM trade_calendar WHERE is_open=1 AND cal_date<s.latest
        )) ORDER BY v.trade_date`,
        [JSON.stringify(keys)],
      );
      return groupSeries(keys, rows);
    });
  }

  getOverlay(): Promise<FinancePoint[]> {
    return this.read<FinancePoint[]>([], (db) =>
      db.select<FinancePoint[]>(
        `WITH quotes AS (
          SELECT trade_date,close FROM index_daily WHERE ts_code='000300.SH'
        ), bounds AS (
          SELECT min(trade_date) AS first_date,max(trade_date) AS last_date FROM quotes
        ), days AS (
          SELECT trade_date FROM quotes
          UNION
          SELECT c.cal_date FROM bounds AS b JOIN trade_calendar AS c
            ON c.cal_date BETWEEN b.first_date AND b.last_date
          WHERE c.is_open=1
        )
        SELECT d.trade_date,q.close AS value,NULL AS extra_json
        FROM days AS d LEFT JOIN quotes AS q USING (trade_date)
        ORDER BY d.trade_date`,
      ),
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
