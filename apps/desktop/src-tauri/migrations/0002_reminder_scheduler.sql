-- 保留重复规则的起点与时区；推进 due_at 后仍能正确计算 COUNT、月末与夏令时。
ALTER TABLE reminders ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE reminders ADD COLUMN recurrence_start_at INTEGER;
ALTER TABLE reminders ADD COLUMN schedule_version TEXT NOT NULL DEFAULT '';
UPDATE reminders SET recurrence_start_at = due_at, schedule_version = id;

-- 每次提醒保留独立状态，旧通知的完成/贪睡不会作用于已经推进的下一次。
CREATE TABLE reminder_occurrences (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id TEXT NOT NULL,
  deletion_group_id TEXT,
  purged_at INTEGER,
  reminder_id TEXT NOT NULL REFERENCES reminders(id),
  occurrence_key TEXT NOT NULL,
  schedule_key TEXT NOT NULL,
  due_at INTEGER,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  notified_at INTEGER,
  completed_at INTEGER,
  snooze_until INTEGER
);
CREATE UNIQUE INDEX idx_reminder_occurrence_key ON reminder_occurrences(occurrence_key, schedule_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_reminder_occurrences_parent ON reminder_occurrences(reminder_id);
CREATE INDEX idx_reminder_occurrences_pending ON reminder_occurrences(snooze_until, due_at)
  WHERE deleted_at IS NULL AND completed_at IS NULL AND notified_at IS NULL;
