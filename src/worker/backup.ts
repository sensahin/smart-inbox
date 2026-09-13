import type { AppEnv } from "./env";
import { all, now, recordEvent, run, setting, setSetting } from "./db";
export const BACKUP_TABLES = [
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
] as const;
export async function backup(env: AppEnv) {
  const lease = String(now() + 300000);
  const claimed = await run(
    env.DB,
    "INSERT INTO settings(key,value) VALUES ('backup_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<?",
    lease,
    now(),
  );
  if (!claimed.meta.changes) return;
  try {
    await exportSnapshot(env);
    await setSetting(env, "backup_error", "");
  } catch (error) {
    await setSetting(
      env,
      "backup_error",
      "The last backup attempt failed. Check Recent activity and run another backup.",
    );
    await recordEvent(
      env,
      "backup_failed",
      null,
      "Backup failed; the last complete export was retained.",
    );
    throw error;
  } finally {
    await run(
      env.DB,
      "UPDATE settings SET value='0' WHERE key='backup_lease' AND value=?",
      lease,
    );
  }
}
async function exportSnapshot(env: AppEnv) {
  const date = new Date().toISOString().slice(0, 10),
    prefix = `daily/${date}/${crypto.randomUUID()}/`;
  const manifest: { table: string; key: string; rows: number }[] = [];
  // One D1 batch obtains a consistent relational snapshot; bodies and attachments use immutable R2 keys.
  const result = await env.DB.batch(
    BACKUP_TABLES.map((t) => env.DB.prepare(`SELECT * FROM ${t}`)),
  );
  for (let i = 0; i < BACKUP_TABLES.length; i++) {
    const table = BACKUP_TABLES[i],
      rows = result[i].results;
    const key = `${prefix}${table}.json`;
    await env.BACKUPS.put(key, JSON.stringify(rows), {
      httpMetadata: { contentType: "application/json" },
    });
    manifest.push({ table, key, rows: rows.length });
  }
  const key = `${prefix}manifest.json`;
  await env.BACKUPS.put(
    key,
    JSON.stringify({
      version: 1,
      created_at: now(),
      tables: manifest,
      attachments_bucket: "FILES",
      recovery: "Restore with sending paused; reconcile Gmail before resuming.",
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  await setSetting(env, "last_backup", JSON.stringify({ at: now(), key }));
  const cutoff = new Date(now() - 30 * 24 * 3600000).toISOString().slice(0, 10);
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list({ prefix: "daily/", cursor });
    const expired = page.objects
      .filter(
        (o) =>
          o.key.split("/")[1] <= cutoff ||
          (o.key.split("/")[1] === date && !o.key.startsWith(prefix)),
      )
      .map((o) => o.key);
    if (expired.length) await env.BACKUPS.delete(expired);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await recordEvent(env, "backup_complete", null, `Completed backup ${date}.`);
}
export async function maintenance(env: AppEnv) {
  await run(env.DB, "DELETE FROM oauth_states WHERE expires_at<?", now());
  // Only discard abandoned uploads which no draft or outgoing payload still references.
  const abandoned = await all<{ id: string; object_key: string }>(
    env.DB,
    "SELECT id,object_key FROM attachments a WHERE message_id IS NULL AND created_at<? AND NOT EXISTS(SELECT 1 FROM drafts d WHERE instr(d.payload,a.id)>0) AND NOT EXISTS(SELECT 1 FROM outgoing o WHERE instr(o.payload,a.id)>0) LIMIT 100",
    now() - 7 * 24 * 3600000,
  );
  for (const a of abandoned) {
    await env.FILES.delete(a.object_key);
    await run(env.DB, "DELETE FROM attachments WHERE id=?", a.id);
  }
  if ((await setting(env, "last_backup")) === "") await backup(env);
}
