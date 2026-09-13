export const tables = [
  "settings",
  "mailboxes",
  "inboxes",
  "contacts",
  "conversations",
  "thread_links",
  "messages",
  "attachments",
  "drafts",
  "saved_replies",
  "outgoing",
  "integration_snapshots",
  "events",
  "counters",
  "message_attachments",
  "ai_runs",
  "ai_documents",
  "message_opens",
  "conversation_status_events",
];
const identifier = (value) => {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid snapshot column.");
  return '"' + value + '"';
};
const literal = (value) => {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") throw new Error("Invalid snapshot value.");
  return "'" + value.replaceAll("'", "''") + "'";
};
const primaryKeys = {
  message_opens: ["outgoing_id"],
  settings: ["key"],
  counters: ["name"],
  thread_links: ["mailbox_id", "thread_id"],
  integration_snapshots: ["contact_id", "provider"],
  message_attachments: ["message_id", "attachment_id"],
};
export function recoveryStatements(snapshot) {
  const hasReportHistory = Array.isArray(snapshot.conversation_status_events);
  snapshot = {
    ai_runs: [],
    ai_documents: [],
    message_opens: [],
    conversation_status_events: [],
    ...snapshot,
  };
  for (const table of tables)
    if (!Array.isArray(snapshot[table]))
      throw new Error("Missing snapshot table: " + table);
  const statements = [
    "PRAGMA defer_foreign_keys=ON",
    ...tables
      .slice()
      .reverse()
      .map((t) => "DELETE FROM " + identifier(t)),
    "DELETE FROM oauth_states",
  ];
  for (const table of tables)
    for (const row of snapshot[table]) {
      const columns = Object.keys(row);
      if (!columns.length) throw new Error("Empty snapshot row.");
      const keys = primaryKeys[table] || ["id"];
      if (keys.some((key) => row[key] == null))
        throw new Error("Missing snapshot primary key.");
      const large = columns.filter(
        (column) =>
          typeof row[column] === "string" &&
          row[column].length > 512 &&
          !keys.includes(column),
      );
      statements.push(
        `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(",")}) VALUES (${columns.map((c) => literal(large.includes(c) ? "" : row[c])).join(",")})`,
      );
      const where = keys
        .map((key) => `${identifier(key)}=${literal(row[key])}`)
        .join(" AND ");
      // D1 limits SQL statement length. Append large text in Unicode-safe chunks.
      for (const column of large) {
        const characters = Array.from(row[column]);
        for (let start = 0; start < characters.length; start += 8192) {
          const chunk = characters.slice(start, start + 8192).join("");
          statements.push(
            `UPDATE ${identifier(table)} SET ${identifier(column)}=${identifier(column)}||${literal(chunk)} WHERE ${where}`,
          );
        }
      }
    }
  if (!hasReportHistory)
    statements.push(
      `INSERT INTO settings(key,value) VALUES ('reporting_started_at','${Date.now()}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
  statements.push(
    "INSERT INTO settings(key,value) VALUES ('sending_enabled','false'),('acknowledgements_enabled','false'),('open_tracking_enabled','false'),('restore_reconciled','false'),('ai_paused','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    "UPDATE settings SET value='0' WHERE key='backup_lease'",
    "UPDATE ai_runs SET state='failed',reason='Restored run requires manual regeneration.' WHERE state IN ('queued','running')",
    "UPDATE mailboxes SET lease_owner=NULL,lease_until=0",
    "UPDATE outgoing SET state='uncertain',lease_owner=NULL,lease_until=0,error='Restored job requires Gmail reconciliation.' WHERE state<>'sent'",
  );
  return statements;
}
