-- 模块创建的备忘录记录来源，供授权写入和卸载清理。
ALTER TABLE memos ADD COLUMN source_workbench TEXT;
CREATE INDEX idx_memos_module ON memos(source_workbench) WHERE source_workbench IS NOT NULL;
