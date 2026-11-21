-- 对话记录只在本机，不参与同步。
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, device_id TEXT NOT NULL, deletion_group_id TEXT, purged_at INTEGER,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','card','results','error')),
  text TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT
);
CREATE INDEX idx_ai_messages_created ON ai_messages(created_at) WHERE deleted_at IS NULL;
