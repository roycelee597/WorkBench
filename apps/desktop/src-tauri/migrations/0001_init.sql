-- 首次迁移；后续版本只能新增迁移文件，不修改已发布迁移。
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  deletion_group_id TEXT,
  purged_at INTEGER,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags))
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  deletion_group_id TEXT,
  purged_at INTEGER,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK (end_at >= start_at),
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  rrule TEXT,
  color TEXT,
  source_workbench TEXT,
  exdates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exdates)),
  recurrence_id TEXT REFERENCES events(id),
  original_start_at INTEGER,
  remind_before_minutes INTEGER CHECK (remind_before_minutes >= 0),
  CHECK ((recurrence_id IS NULL) = (original_start_at IS NULL))
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  deletion_group_id TEXT,
  purged_at INTEGER,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  rrule TEXT,
  completed_at INTEGER,
  notified_at INTEGER,
  snooze_until INTEGER,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  event_id TEXT REFERENCES events(id),
  source_workbench TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'event'))
);

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  deletion_group_id TEXT,
  purged_at INTEGER,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE TABLE installed_workbenches (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  granted_permissions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  install_path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workbench_kv (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  workbench_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (workbench_id, key)
);

CREATE INDEX idx_events_range ON events(start_at, end_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_reminders_due ON reminders(due_at)
  WHERE deleted_at IS NULL AND completed_at IS NULL;
CREATE INDEX idx_reminders_event ON reminders(event_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_events_exception ON events(recurrence_id, original_start_at)
  WHERE recurrence_id IS NOT NULL AND deleted_at IS NULL;
