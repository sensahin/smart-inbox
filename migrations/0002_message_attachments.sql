CREATE TABLE message_attachments (
 message_id TEXT NOT NULL REFERENCES messages(id),
 attachment_id TEXT NOT NULL REFERENCES attachments(id),
 PRIMARY KEY(message_id,attachment_id)
);
INSERT INTO message_attachments SELECT message_id,id FROM attachments WHERE message_id IS NOT NULL;
