ALTER TABLE conversations ADD COLUMN merged_into TEXT;
CREATE INDEX conversations_merged_into ON conversations(merged_into);
