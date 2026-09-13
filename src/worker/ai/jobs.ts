import type { AppEnv } from "../env";
import type { AIRun, AISource } from "../../shared/ai";
import type { Contact, Conversation, Inbox, Message } from "../../shared/types";
import { all, AppError, now, one, parseJson, run, setting, uid } from "../db";
import { customerIntegration } from "../integrations";
import { replyToHtml } from "./reply";
import { aiConfig } from "./config";
import {
  automatedReason,
  paidEligibility,
  redactReference,
} from "./eligibility";
export async function queueDraft(
  env: AppEnv,
  conversationId: string,
  manual = false,
) {
  const config = await aiConfig(env);
  if (!config.enabled) {
    if (manual) throw new AppError(409, "Enable AI drafts in Settings first.");
    return null;
  }
  if ((await setting(env, "restore_reconciled")) !== "true")
    throw new AppError(409, "Finish restore reconciliation before using AI.");
  const c = await one<Conversation>(
    env.DB,
    "SELECT * FROM conversations WHERE id=?",
    conversationId,
  );
  if (!c?.last_inbound_id || c.deleted_at || c.status === "closed") {
    if (manual)
      throw new AppError(
        409,
        "Open a customer conversation with an incoming message first.",
      );
    return null;
  }
  const m = await one<Message>(
    env.DB,
    "SELECT * FROM messages WHERE id=?",
    c.last_inbound_id,
  );
  if (!m || (!manual && m.sent_at < config.enabled_at)) return null;
  const existing = await one<AIRun>(
    env.DB,
    "SELECT * FROM ai_runs WHERE conversation_id=? AND input_id=? ORDER BY attempt DESC LIMIT 1",
    c.id,
    m.id,
  );
  if (existing && (!manual || ["queued", "running"].includes(existing.state)))
    return existing;
  if (existing && existing.attempt >= 3)
    throw new AppError(429, "This message has reached its regeneration limit.");
  const id = uid();
  await run(
    env.DB,
    "INSERT OR IGNORE INTO ai_runs(id,conversation_id,input_id,attempt,model,config_revision,ticket_status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND deleted_at IS NULL AND revision=? AND last_inbound_id=?)",
    id,
    c.id,
    m.id,
    manual ? (existing?.attempt ?? -1) + 1 : 0,
    config.model,
    config.revision,
    c.status,
    now(),
    now(),
    c.id,
    c.revision,
    m.id,
  );
  const saved = await one<AIRun>(
    env.DB,
    "SELECT * FROM ai_runs WHERE id=?",
    id,
  );
  if (saved)
    await env.AI_JOBS.send({
      type: "ai-draft",
      runId: id,
      conversationId: c.id,
    });
  return saved;
}
export async function recoverDraftJobs(env: AppEnv) {
  // A timeout is never automatically retried: inference may already have been billed.
  await run(
    env.DB,
    "UPDATE ai_runs SET state='failed',reason='Generation was interrupted. You can try again manually.',updated_at=? WHERE state='running' AND updated_at<?",
    now(),
    now() - 600000,
  );
  if (!(await aiConfig(env)).enabled) return;
  const pending = await all<AIRun>(
    env.DB,
    "SELECT * FROM ai_runs WHERE state='queued' ORDER BY created_at LIMIT 10",
  );
  for (const r of pending)
    await env.AI_JOBS.send({
      type: "ai-draft",
      runId: r.id,
      conversationId: r.conversation_id,
    });
}
export async function stopRun(
  env: AppEnv,
  id: string,
  reason: string,
  state: "skipped" | "failed" = "skipped",
) {
  await run(
    env.DB,
    "UPDATE ai_runs SET state=?,reason=?,updated_at=? WHERE id=? AND state IN ('queued','running')",
    state,
    reason,
    now(),
    id,
  );
}
export async function prepareRun(env: AppEnv, id: string) {
  const job = await one<AIRun>(
    env.DB,
    "SELECT * FROM ai_runs WHERE id=? AND state='queued'",
    id,
  );
  if (!job) return null;
  const config = await aiConfig(env);
  if (
    !config.enabled ||
    config.revision !== job.config_revision ||
    (await setting(env, "restore_reconciled")) !== "true"
  ) {
    await stopRun(env, id, "AI was disabled or its settings changed.");
    return null;
  }
  const c = await one<Conversation>(
    env.DB,
    "SELECT * FROM conversations WHERE id=?",
    job.conversation_id,
  );
  if (
    !c ||
    c.deleted_at ||
    c.last_inbound_id !== job.input_id ||
    c.status !== job.ticket_status
  ) {
    await stopRun(env, id, "Conversation changed before generation.");
    return null;
  }
  const contact = (await one<Contact>(
    env.DB,
    "SELECT * FROM contacts WHERE id=?",
    c.contact_id,
  ))!;
  const m = (await one<Message>(
    env.DB,
    "SELECT * FROM messages WHERE id=?",
    job.input_id,
  ))!;
  const inbox = (await one<Inbox>(
    env.DB,
    "SELECT * FROM inboxes WHERE id=?",
    c.inbox_id,
  ))!;
  const addresses = (
    await all<{ address: string }>(env.DB, "SELECT address FROM inboxes")
  ).map((i) => i.address.toLowerCase());
  const gate = automatedReason(m, contact, addresses);
  if (gate) {
    await stopRun(env, id, gate);
    return null;
  }
  if (await one(env.DB, "SELECT id FROM drafts WHERE id=?", `reply:${c.id}`)) {
    await stopRun(
      env,
      id,
      "An existing draft needs your review. AI will not replace it.",
    );
    return null;
  }
  if (
    (await one(
      env.DB,
      "SELECT id FROM outgoing WHERE conversation_id=? AND kind<>'auto' AND created_at>=?",
      c.id,
      m.sent_at,
    )) ||
    (await one(
      env.DB,
      "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound' AND sent_at>=?",
      c.id,
      m.sent_at,
    ))
  ) {
    await stopRun(
      env,
      id,
      "The customer already has a reply or a send in progress.",
    );
    return null;
  }
  if (config.eligibility === "paid_freemius") {
    const provider = await customerIntegration(env, contact, "freemius");
    const paid = paidEligibility(
      provider,
      contact.freemius_email || contact.email,
    );
    if (paid) {
      await stopRun(env, id, paid);
      return null;
    }
  }
  const day = new Date().setUTCHours(0, 0, 0, 0);
  const claim = await run(
    env.DB,
    "UPDATE ai_runs SET state='running',started_at=?,updated_at=? WHERE id=? AND state='queued' AND (SELECT COUNT(*) FROM ai_runs WHERE started_at>=?)<?",
    now(),
    now(),
    id,
    day,
    config.daily_limit,
  );
  if (!claim.meta.changes) {
    await stopRun(env, id, "Daily AI draft limit reached.");
    return null;
  }
  const messages = await all<Message>(
    env.DB,
    "SELECT * FROM messages WHERE conversation_id=? AND direction<>'auto' ORDER BY sent_at DESC LIMIT 6",
    c.id,
  );
  const context = messages.reverse().map((m) => ({
    direction: m.direction,
    subject: m.subject,
    body: redactReference(m.search_text).slice(0, 4000),
  }));
  return { job, config, c, contact, m, inbox, context };
}
export type PreparedRun = NonNullable<Awaited<ReturnType<typeof prepareRun>>>;
export async function saveGeneratedDraft(
  env: AppEnv,
  prepared: PreparedRun,
  output: {
    reply: string;
    notes: string;
    sources: AISource[];
    inputTokens: number;
    outputTokens: number;
  },
) {
  const { job, c, contact, m, inbox, config } = prepared;
  const fresh = await aiConfig(env);
  if (!fresh.enabled || fresh.revision !== config.revision) {
    await stopRun(env, job.id, "AI settings changed during generation.");
    return;
  }
  const headers = parseJson<Record<string, string>>(m.headers, {});
  const to = parseJson<string[]>(headers["reply-to-addresses"] || "[]", []);
  const payload = JSON.stringify({
    inbox_id: inbox.id,
    to: to.length ? to.join(", ") : contact.email,
    cc: "",
    bcc: "",
    subject: c.subject,
    html: replyToHtml(output.reply),
    text: output.reply,
    attachment_ids: [],
    attachments: [],
    kind: "reply",
    idempotency_key: uid(),
    ai_run_id: job.id,
  });
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO drafts(id,conversation_id,payload,version,updated_at)
 SELECT ?,?,?,1,? WHERE EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND state='running')
 AND EXISTS(SELECT 1 FROM conversations WHERE id=? AND last_inbound_id=? AND deleted_at IS NULL AND status=?)
 AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND direction='outbound' AND sent_at>=?)
 AND NOT EXISTS(SELECT 1 FROM outgoing WHERE conversation_id=? AND kind<>'auto' AND created_at>=?)
 AND NOT EXISTS(SELECT 1 FROM settings WHERE key='ai_paused' AND value='true')
 AND EXISTS(SELECT 1 FROM settings WHERE key='ai_config' AND json_extract(value,'$.enabled')=1 AND json_extract(value,'$.revision')=?)`,
  ).bind(
    `reply:${c.id}`,
    c.id,
    payload,
    now(),
    job.id,
    c.id,
    m.id,
    job.ticket_status,
    c.id,
    m.sent_at,
    c.id,
    m.sent_at,
    config.revision,
  );
  const hasDraft =
    "EXISTS(SELECT 1 FROM drafts WHERE id=? AND json_extract(payload,'$.ai_run_id')=ai_runs.id)";
  await env.DB.batch([
    insert,
    env.DB.prepare(
      `UPDATE ai_runs SET state=CASE WHEN ${hasDraft} THEN 'draft' ELSE 'skipped' END,reason=CASE WHEN ${hasDraft} THEN '' ELSE 'Draft or conversation changed during generation. Result was not applied.' END,result=?,sources=?,notes=?,input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND state='running'`,
    ).bind(
      `reply:${c.id}`,
      `reply:${c.id}`,
      output.reply,
      JSON.stringify(output.sources),
      output.notes,
      output.inputTokens,
      output.outputTokens,
      now(),
      job.id,
    ),
  ]);
}
