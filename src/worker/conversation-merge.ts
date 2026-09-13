import type { Conversation } from "../shared/types";
import type { AppEnv } from "./env";
import { all, AppError, now, one, run, uid } from "./db";

export async function mergeConversations(
  env: AppEnv,
  targetId: string,
  sourceId: string,
  targetRevision: number,
  sourceRevision: number,
) {
  if (sourceId === targetId)
    throw new AppError(400, "Choose a different conversation to merge.");
  const rows = await all<Conversation>(
    env.DB,
    "SELECT * FROM conversations WHERE id IN (?,?)",
    sourceId,
    targetId,
  );
  const source = rows.find((row) => row.id === sourceId);
  const target = rows.find((row) => row.id === targetId);
  if (!source || !target) throw new AppError(404, "Conversation not found.");
  if (source.merged_into === targetId && !target.merged_into)
    return { conversation_id: targetId };
  if (source.deleted_at !== null || target.deleted_at !== null)
    throw new AppError(409, "Only conversations outside Trash can be merged.");
  if (
    source.contact_id !== target.contact_id ||
    source.inbox_id !== target.inbox_id ||
    !source.mailbox_id ||
    source.mailbox_id !== target.mailbox_id
  )
    throw new AppError(
      409,
      "Merge requires the same customer, inbox, and mailbox.",
    );
  if (source.revision !== sourceRevision || target.revision !== targetRevision)
    throw new AppError(409, "A conversation changed. Refresh and try again.");
  if (
    await one(
      env.DB,
      "SELECT id FROM drafts WHERE conversation_id=? OR id=?",
      sourceId,
      `reply:${sourceId}`,
    )
  )
    throw new AppError(
      409,
      "Send or discard the draft in the previewed conversation before merging.",
    );
  if (
    await one(
      env.DB,
      "SELECT id FROM outgoing WHERE conversation_id IN (?,?) AND state<>'sent'",
      sourceId,
      targetId,
    )
  )
    throw new AppError(
      409,
      "Resolve unfinished sends in both conversations before merging.",
    );
  if (
    await one(
      env.DB,
      "SELECT id FROM ai_runs WHERE conversation_id IN (?,?) AND state IN ('queued','running')",
      sourceId,
      targetId,
    )
  )
    throw new AppError(
      409,
      "Wait for AI draft generation to finish before merging.",
    );

  // Synchronization uses this same lease, so it cannot insert using an old thread mapping.
  const owner = uid();
  const claimed = await run(
    env.DB,
    "UPDATE mailboxes SET lease_owner=?,lease_until=? WHERE id=? AND lease_until<?",
    owner,
    now() + 120000,
    source.mailbox_id,
    now(),
  );
  if (!claimed.meta.changes)
    throw new AppError(
      409,
      "This mailbox is synchronizing. Try merging again in a moment.",
    );
  try {
    const marker = uid(),
      timestamp = now();
    const gate = "EXISTS(SELECT 1 FROM events WHERE id=?)";
    const guarded = (sql: string, ...values: unknown[]) =>
      env.DB.prepare(sql).bind(...values, marker);
    // One atomic batch: the marker rechecks all mutable preconditions at commit time.
    // Every write depends on it, including redirects and future Gmail thread routing.
    const statements = [
      env.DB.prepare(
        `INSERT INTO events(id,kind,entity_id,detail,created_at)
        SELECT ?,'conversation_merged',?,?,? WHERE EXISTS(
          SELECT 1 FROM conversations s JOIN conversations t ON t.id=?
          JOIN mailboxes m ON m.id=s.mailbox_id
          WHERE s.id=? AND s.revision=? AND t.revision=?
          AND s.deleted_at IS NULL AND t.deleted_at IS NULL
          AND s.merged_into IS NULL AND t.merged_into IS NULL
          AND s.contact_id=t.contact_id AND s.inbox_id=t.inbox_id AND s.mailbox_id=t.mailbox_id
          AND m.lease_owner=? AND m.lease_until>?)
        AND NOT EXISTS(SELECT 1 FROM drafts WHERE conversation_id=? OR id=?)
        AND NOT EXISTS(SELECT 1 FROM outgoing WHERE conversation_id IN (?,?) AND state<>'sent')
        AND NOT EXISTS(SELECT 1 FROM ai_runs WHERE conversation_id IN (?,?) AND state IN ('queued','running'))`,
      ).bind(
        marker,
        targetId,
        `Merged conversation #${source.number} into #${target.number}.`,
        timestamp,
        targetId,
        sourceId,
        sourceRevision,
        targetRevision,
        owner,
        timestamp,
        sourceId,
        `reply:${sourceId}`,
        sourceId,
        targetId,
        sourceId,
        targetId,
      ),
      guarded(
        `INSERT INTO thread_links(mailbox_id,thread_id,conversation_id)
        SELECT mailbox_id,gmail_thread_id,? FROM conversations WHERE id=? AND gmail_thread_id IS NOT NULL AND ${gate}
        ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET conversation_id=excluded.conversation_id`,
        targetId,
        sourceId,
      ),
      guarded(
        `UPDATE thread_links SET conversation_id=? WHERE conversation_id=? AND ${gate}`,
        targetId,
        sourceId,
      ),
      ...[
        "messages",
        "attachments",
        "ai_runs",
        "conversation_status_events",
      ].map((table) =>
        guarded(
          `UPDATE ${table} SET conversation_id=? WHERE conversation_id=? AND ${gate}`,
          targetId,
          sourceId,
        ),
      ),
      guarded(
        `UPDATE outgoing SET conversation_id=?,payload=json_set(payload,'$.conversation_id',?) WHERE conversation_id=? AND ${gate}`,
        targetId,
        targetId,
        sourceId,
      ),
      guarded(
        `UPDATE events SET entity_id=? WHERE entity_id=? AND ${gate}`,
        targetId,
        sourceId,
      ),
      guarded(
        `UPDATE conversations SET
        created_at=MIN(created_at,(SELECT created_at FROM conversations WHERE id=?)),
        updated_at=MAX(updated_at,(SELECT updated_at FROM conversations WHERE id=?)),
        history_missing=MAX(history_missing,(SELECT history_missing FROM conversations WHERE id=?)),
        unread=MAX(unread,(SELECT unread FROM conversations WHERE id=?)),
        status=CASE WHEN status='open' OR (SELECT status FROM conversations WHERE id=?)='open' THEN 'open'
          WHEN status='waiting' OR (SELECT status FROM conversations WHERE id=?)='waiting' THEN 'waiting' ELSE 'closed' END,
        last_inbound_id=(SELECT id FROM messages WHERE conversation_id=? AND direction='inbound' ORDER BY sent_at DESC,id DESC LIMIT 1),
        snippet=COALESCE((SELECT substr(search_text,1,300) FROM messages WHERE conversation_id=? AND direction<>'auto' ORDER BY sent_at DESC,id DESC LIMIT 1),snippet),
        revision=revision+1 WHERE id=? AND ${gate}`,
        sourceId,
        sourceId,
        sourceId,
        sourceId,
        sourceId,
        sourceId,
        targetId,
        targetId,
        targetId,
      ),
      guarded(
        `UPDATE conversations SET merged_into=? WHERE merged_into=? AND ${gate}`,
        targetId,
        sourceId,
      ),
      guarded(
        `UPDATE conversations SET merged_into=?,deleted_at=?,unread=0,revision=revision+1 WHERE id=? AND ${gate}`,
        targetId,
        timestamp,
        sourceId,
      ),
    ];
    const result = await env.DB.batch(statements);
    if (!result[0].meta.changes)
      throw new AppError(
        409,
        "A conversation changed or has unfinished work. Refresh and try again.",
      );
    return { conversation_id: targetId };
  } finally {
    await run(
      env.DB,
      "UPDATE mailboxes SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?",
      source.mailbox_id,
      owner,
    );
  }
}
