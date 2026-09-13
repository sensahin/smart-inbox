PRAGMA foreign_keys = ON;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('sending_enabled','false'),('acknowledgements_enabled','false'),('restore_reconciled','true');
CREATE TABLE mailboxes (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, refresh_token TEXT NOT NULL,
 history_id TEXT NOT NULL, cutover_at INTEGER NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
 state TEXT NOT NULL DEFAULT 'connected', last_sync_at INTEGER, error TEXT,
 lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE inboxes (
 id TEXT PRIMARY KEY, mailbox_id TEXT REFERENCES mailboxes(id), name TEXT NOT NULL,
 address TEXT NOT NULL UNIQUE, from_name TEXT NOT NULL, signature TEXT NOT NULL DEFAULT '',
 signature_aliases INTEGER NOT NULL DEFAULT 1, default_status TEXT NOT NULL DEFAULT 'closed' CHECK(default_status IN ('open','waiting','closed')),
 auto_bcc TEXT NOT NULL DEFAULT '', auto_reply TEXT NOT NULL DEFAULT '', auto_reply_mode TEXT NOT NULL DEFAULT 'always' CHECK(auto_reply_mode IN ('always','outside_hours','off')),
 timezone TEXT NOT NULL DEFAULT 'UTC', office_start INTEGER NOT NULL DEFAULT 9, office_end INTEGER NOT NULL DEFAULT 17,
 routing_priority INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL
);
CREATE TABLE contacts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, freemius_email TEXT, created_at INTEGER NOT NULL);
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, inbox_id TEXT NOT NULL REFERENCES inboxes(id),
 contact_id TEXT NOT NULL REFERENCES contacts(id), mailbox_id TEXT REFERENCES mailboxes(id), gmail_thread_id TEXT,
 subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting','closed')),
 unread INTEGER NOT NULL DEFAULT 1, history_missing INTEGER NOT NULL DEFAULT 0,
 last_inbound_id TEXT, snippet TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(mailbox_id, gmail_thread_id)
);
CREATE INDEX conversations_list ON conversations(inbox_id,status,updated_at DESC);
CREATE INDEX conversations_contact ON conversations(contact_id,updated_at DESC);
CREATE TABLE thread_links (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), thread_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), PRIMARY KEY(mailbox_id,thread_id));
CREATE TABLE messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), mailbox_id TEXT REFERENCES mailboxes(id),
 gmail_id TEXT, rfc_message_id TEXT, direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','auto')),
 sender TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', recipients TEXT NOT NULL DEFAULT '[]', cc TEXT NOT NULL DEFAULT '[]',
 subject TEXT NOT NULL, body_key TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '',
 headers TEXT NOT NULL DEFAULT '{}', sent_at INTEGER NOT NULL, UNIQUE(mailbox_id,gmail_id)
);
CREATE INDEX messages_conversation ON messages(conversation_id,sent_at);
CREATE INDEX messages_rfc ON messages(mailbox_id,rfc_message_id);
CREATE TABLE attachments (
 id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), message_id TEXT REFERENCES messages(id),
 object_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
 content_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE drafts (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE saved_replies (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE outgoing (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), message_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('reply','new','forward','auto')),
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','failed')),
 desired_status TEXT NOT NULL, last_inbound_id TEXT, gmail_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX outgoing_pending ON outgoing(state,next_attempt_at);
CREATE TABLE integration_snapshots (contact_id TEXT NOT NULL REFERENCES contacts(id), provider TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(contact_id,provider));
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, owner_email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO counters VALUES ('ticket',0);
