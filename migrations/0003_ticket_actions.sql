ALTER TABLE conversations ADD COLUMN deleted_at INTEGER;
ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN gmail_thread_id TEXT;
UPDATE messages SET gmail_thread_id=(SELECT MIN(t.thread_id) FROM thread_links t WHERE t.conversation_id=messages.conversation_id AND t.mailbox_id=messages.mailbox_id HAVING COUNT(*)=1);
CREATE INDEX conversations_folder ON conversations(deleted_at,status,updated_at DESC);
