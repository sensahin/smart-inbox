CREATE TABLE conversation_status_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX status_events_conversation ON conversation_status_events(conversation_id, changed_at);
CREATE INDEX status_events_time ON conversation_status_events(changed_at, conversation_id);
CREATE INDEX messages_report_time ON messages(sent_at, conversation_id);
CREATE INDEX conversations_created ON conversations(created_at, inbox_id);

INSERT OR IGNORE INTO settings(key,value)
VALUES ('reporting_started_at', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT));

-- Capture every status writer atomically, including synchronization and send acceptance.
CREATE TRIGGER conversation_status_changed AFTER UPDATE OF status ON conversations
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO conversation_status_events(id,conversation_id,from_status,to_status,changed_at)
  VALUES (lower(hex(randomblob(16))),NEW.id,OLD.status,NEW.status,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
