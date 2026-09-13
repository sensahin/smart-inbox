CREATE TABLE ai_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 input_id TEXT NOT NULL REFERENCES messages(id), attempt INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL, config_revision TEXT NOT NULL, ticket_status TEXT NOT NULL,
 result TEXT, sources TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(conversation_id,input_id,attempt)
);
CREATE INDEX ai_runs_pending ON ai_runs(state,created_at);
CREATE TABLE ai_documents (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL,
 content TEXT NOT NULL, generation TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE ai_documents_fts USING fts5(title,content,content='ai_documents',content_rowid='rowid');
CREATE TRIGGER ai_documents_insert AFTER INSERT ON ai_documents BEGIN
 INSERT INTO ai_documents_fts(rowid,title,content) VALUES (new.rowid,new.title,new.content);
END;
CREATE TRIGGER ai_documents_delete AFTER DELETE ON ai_documents BEGIN
 INSERT INTO ai_documents_fts(ai_documents_fts,rowid,title,content) VALUES ('delete',old.rowid,old.title,old.content);
END;
CREATE TRIGGER ai_documents_update AFTER UPDATE ON ai_documents BEGIN
 INSERT INTO ai_documents_fts(ai_documents_fts,rowid,title,content) VALUES ('delete',old.rowid,old.title,old.content);
 INSERT INTO ai_documents_fts(rowid,title,content) VALUES (new.rowid,new.title,new.content);
END;
-- Earlier composer versions saved a subject-only reply when merely opening a ticket.
DELETE FROM drafts WHERE id LIKE 'reply:%' AND COALESCE(json_extract(payload,'$.text'),'')='' AND COALESCE(json_array_length(json_extract(payload,'$.attachment_ids')),0)=0;
