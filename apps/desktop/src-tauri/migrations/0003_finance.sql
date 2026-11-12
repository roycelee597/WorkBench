CREATE TABLE finance_thresholds (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, device_id TEXT NOT NULL, deletion_group_id TEXT, purged_at INTEGER,
  indicator_id TEXT NOT NULL,
  series_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  level REAL NOT NULL,
  hysteresis REAL NOT NULL DEFAULT 0 CHECK (hysteresis >= 0),
  enabled INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  default_key TEXT
);
CREATE UNIQUE INDEX idx_finance_thresholds_default ON finance_thresholds(default_key) WHERE default_key IS NOT NULL;
CREATE INDEX idx_finance_thresholds_series ON finance_thresholds(series_key) WHERE deleted_at IS NULL;

CREATE TABLE finance_alert_states (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, device_id TEXT NOT NULL, deletion_group_id TEXT, purged_at INTEGER,
  threshold_id TEXT NOT NULL REFERENCES finance_thresholds(id),
  threshold_version INTEGER NOT NULL,
  breached INTEGER NOT NULL,
  evaluated_through INTEGER NOT NULL,
  last_crossed_date INTEGER,
  last_reminder_id TEXT REFERENCES reminders(id)
);
CREATE UNIQUE INDEX idx_finance_alert_state_threshold ON finance_alert_states(threshold_id) WHERE deleted_at IS NULL;
