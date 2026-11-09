PRAGMA journal_mode = WAL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE trade_calendar (cal_date INTEGER PRIMARY KEY, is_open INTEGER NOT NULL);
CREATE TABLE securities (
  sid INTEGER PRIMARY KEY,
  ts_code TEXT NOT NULL UNIQUE, name TEXT, exchange TEXT, market TEXT,
  list_date INTEGER, delist_date INTEGER, list_status TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE stock_daily (
  trade_date INTEGER NOT NULL, sid INTEGER NOT NULL,
  close REAL NOT NULL, amount REAL NOT NULL, adj_factor REAL,
  source TEXT NOT NULL DEFAULT 'tushare',
  PRIMARY KEY (trade_date, sid)
) WITHOUT ROWID;
CREATE TABLE index_daily (
  ts_code TEXT, trade_date INTEGER, close REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'tushare',
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE index_valuation (
  ts_code TEXT, trade_date INTEGER, pe REAL, pe_ttm REAL, pb REAL,
  source TEXT NOT NULL DEFAULT 'tushare',
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE dataset_status (
  dataset TEXT NOT NULL, trade_date INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','empty','pending','error')),
  rows INTEGER, source TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (dataset, trade_date)
) WITHOUT ROWID;
CREATE TABLE indicator_meta (
  indicator_id TEXT PRIMARY KEY, meta_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE indicator_values (
  series_key TEXT NOT NULL, trade_date INTEGER NOT NULL, value REAL, extra_json TEXT,
  computed_at INTEGER NOT NULL, engine_version TEXT NOT NULL,
  PRIMARY KEY (series_key, trade_date)
) WITHOUT ROWID;
CREATE TABLE run_log (
  run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
  mode TEXT NOT NULL, status TEXT, error_code TEXT, error_message TEXT, summary_json TEXT
);
