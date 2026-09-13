CREATE TABLE message_opens (
  outgoing_id TEXT PRIMARY KEY REFERENCES outgoing(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  image_url TEXT NOT NULL,
  first_opened_at INTEGER,
  created_at INTEGER NOT NULL
);
