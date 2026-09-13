import { workspaceSettings } from "./workspace";
import { outgoingHtml, prepareOpenTracking } from "./open-tracking";
import { z } from "zod";
import { sameEmailSubject, supportSubject } from "../shared/subjects";
import type { AppEnv } from "./env";
import type {
  Attachment,
  ComposePayload,
  Conversation,
  Inbox,
  Message,
  Outgoing,
} from "../shared/types";
import {
  all,
  AppError,
  now,
  one,
  parseJson,
  recordEvent,
  run,
  setting,
  uid,
} from "./db";
import {
  accessToken,
  getMailbox,
  gmail,
  GoogleError,
  verifiedSendingAddress,
} from "./google";
import {
  buildMime,
  cleanHtml,
  type MimeAttachment,
  parseAddresses,
  template,
  textToHtml,
} from "./mail";
import { sha256 } from "./secrets";
const email = z.string().trim().toLowerCase().email().max(254);
export const composeSchema = z.object({
  inbox_id: z.string().min(1),
  to: z.array(email).min(1).max(30),
  cc: z.array(email).max(30).default([]),
  bcc: z.array(email).max(30).default([]),
  subject: z
    .string()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s)),
  html: z.string().max(200000),
  text: z.string().max(100000),
  attachment_ids: z.array(z.string()).max(20).default([]),
  kind: z.enum(["new", "reply", "forward", "auto"]),
  status: z.enum(["open", "waiting", "closed"]),
  conversation_id: z.string().optional(),
  draft_id: z.string().optional(),
  draft_version: z.number().int().positive().optional(),
  idempotency_key: z.string().min(8).max(160),
});
export async function enqueueOutgoing(env: AppEnv, input: ComposePayload) {
  const payload = composeSchema.parse(input);
  payload.subject = supportSubject(
    payload.subject,
    await workspaceSettings(env),
  );
  const existing = await one<Outgoing>(
    env.DB,
    "SELECT * FROM outgoing WHERE idempotency_key=?",
    payload.idempotency_key,
  );
  if (existing) return existing;
  if (
    (await setting(env, "sending_enabled")) !== "true" ||
    (await setting(env, "restore_reconciled")) !== "true"
  )
    throw new AppError(
      409,
      "Sending is paused. Enable it in Settings after mailbox verification.",
    );
  const inbox = await one<Inbox>(
    env.DB,
    "SELECT * FROM inboxes WHERE id=?",
    payload.inbox_id,
  );
  if (!inbox?.mailbox_id)
    throw new AppError(409, "Connect a Google mailbox to this inbox first.");
  const mailbox = await getMailbox(env, inbox.mailbox_id);
  if (mailbox.state !== "connected")
    throw new AppError(409, "Reconnect this Google mailbox before sending.");
  if (!verifiedSendingAddress(mailbox, inbox.address))
    throw new AppError(
      409,
      "This sending address is not a verified Google alias. Reconnect the mailbox to refresh aliases.",
    );
  const timestamp = now();
  const outgoingId = await sha256(`outgoing:${payload.idempotency_key}`);
  let conversation: Conversation | null = null;
  let ticketNumber: number | undefined;
  const statements: D1PreparedStatement[] = [];
  if (payload.conversation_id) {
    conversation = await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE id=?",
      payload.conversation_id,
    );
    if (!conversation || conversation.inbox_id !== inbox.id)
      throw new AppError(404, "Conversation does not belong to this inbox.");
    if (conversation.deleted_at !== null)
      throw new AppError(
        409,
        "Restore this conversation from Trash before sending.",
      );
    ticketNumber = conversation.number;
  } else {
    if (payload.kind === "reply" || payload.kind === "auto")
      throw new AppError(400, "Reply requires an existing conversation.");
    let contactId = await sha256(`contact:${payload.to[0]}`);
    const id = await sha256(`conversation:${payload.idempotency_key}`);
    await run(
      env.DB,
      "INSERT OR IGNORE INTO contacts(id,email,name,created_at) VALUES (?,?,?,?)",
      contactId,
      payload.to[0],
      payload.to[0],
      timestamp,
    );
    contactId = (await one<{ id: string }>(
      env.DB,
      "SELECT id FROM contacts WHERE email=?",
      payload.to[0],
    ))!.id;
    const number = (await one<{ value: number }>(
      env.DB,
      "UPDATE counters SET value=value+1 WHERE name='ticket' RETURNING value",
    ))!.value;
    ticketNumber = number;
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO conversations(id,number,inbox_id,contact_id,mailbox_id,subject,status,unread,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        number,
        inbox.id,
        contactId,
        mailbox.id,
        payload.subject,
        "open",
        0,
        timestamp,
        timestamp,
      ),
    );
    payload.conversation_id = id;
  }
  const convoId = payload.conversation_id!;
  const inlineImages: Record<string, string> = {};
  let attachmentBytes = 0;
  for (const attachmentId of new Set(payload.attachment_ids)) {
    const a = await one<Attachment>(
      env.DB,
      "SELECT * FROM attachments WHERE id=?",
      attachmentId,
    );
    if (!a || (a.conversation_id && a.conversation_id !== convoId))
      throw new AppError(
        400,
        "Attachment does not belong to this conversation.",
      );
    attachmentBytes += a.size;
    if (a.content_id) {
      inlineImages[`/api/attachments/${a.id}/inline`] = `cid:${a.content_id}`;
      inlineImages[a.content_id] = `cid:${a.content_id}`;
    }
  }
  if (attachmentBytes > 15 * 1024 * 1024)
    throw new AppError(400, "Attachments must total 15 MB or less.");
  const contact = await one<{ name: string; email: string }>(
    env.DB,
    "SELECT name,email FROM contacts WHERE email=?",
    payload.to[0],
  );
  const vars = {
    "customer.firstName":
      contact?.name === contact?.email ? "" : contact?.name.split(" ")[0] || "",
    "customer.fullName": contact?.name || "",
    "customer.email": contact?.email || payload.to[0],
    "inbox.name": inbox.name,
    "ticket.number": String(ticketNumber ?? ""),
  };
  payload.html = cleanHtml(
    payload.html || textToHtml(payload.text),
    inlineImages,
    true,
  );
  if (
    payload.kind !== "auto" &&
    inbox.signature &&
    (inbox.signature_aliases || inbox.address === mailbox.email)
  ) {
    const signature = template(inbox.signature, vars);
    payload.html += `<br>${textToHtml(signature)}`;
    payload.text += `\n\n${signature}`;
  }
  payload.bcc = [
    ...new Set([...payload.bcc, ...parseAddresses(inbox.auto_bcc)]),
  ];
  const messageId = `<${outgoingId}@${inbox.address.split("@")[1]}>`;
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO outgoing(id,idempotency_key,conversation_id,mailbox_id,message_id,kind,payload,desired_status,last_inbound_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND deleted_at IS NULL)",
    ).bind(
      outgoingId,
      payload.idempotency_key,
      convoId,
      mailbox.id,
      messageId,
      payload.kind,
      JSON.stringify(payload),
      payload.status,
      conversation?.last_inbound_id || null,
      timestamp,
      timestamp,
      convoId,
    ),
  );
  if (payload.kind !== "auto") {
    const tracking = await prepareOpenTracking(env, outgoingId, timestamp);
    if (tracking) statements.push(tracking);
  }
  if (payload.draft_id && payload.draft_version)
    statements.push(
      env.DB.prepare(
        "DELETE FROM drafts WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM outgoing WHERE id=?)",
      ).bind(payload.draft_id, payload.draft_version, outgoingId),
    );
  await env.DB.batch(statements);
  if (!(await one(env.DB, "SELECT id FROM outgoing WHERE id=?", outgoingId)))
    throw new AppError(
      409,
      "Restore this conversation from Trash before sending.",
    );
  // The database is authoritative; the minute scheduler also enqueues pending jobs.
  try {
    await env.JOBS.send({ type: "send", outgoingId });
  } catch {
    await recordEvent(
      env,
      "queue_delayed",
      outgoingId,
      "Persisted send will be picked up by the scheduler.",
    );
  }
  return (await one<Outgoing>(
    env.DB,
    "SELECT * FROM outgoing WHERE id=?",
    outgoingId,
  ))!;
}
export async function markSent(
  env: AppEnv,
  job: Outgoing,
  gmailId: string,
  threadId: string,
) {
  if (
    (
      await one<{ state: string }>(
        env.DB,
        "SELECT state FROM outgoing WHERE id=?",
        job.id,
      )
    )?.state === "sent"
  )
    return;
  const payload = JSON.parse(job.payload) as ComposePayload;
  const inbox = (await one<Inbox>(
    env.DB,
    "SELECT * FROM inboxes WHERE id=?",
    payload.inbox_id,
  ))!;
  const bodyKey = `messages/outgoing/${job.id}.json`;
  await env.FILES.put(
    bodyKey,
    JSON.stringify({ html: payload.html, text: payload.text }),
    { httpMetadata: { contentType: "application/json" } },
  );
  const messageId =
    (
      await one<{ id: string }>(
        env.DB,
        "SELECT id FROM messages WHERE mailbox_id=? AND gmail_id=?",
        job.mailbox_id,
        gmailId,
      )
    )?.id || `sent:${job.id}`;
  const timestamp = now();
  const stmts = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,conversation_id,mailbox_id,gmail_id,rfc_message_id,direction,sender,sender_name,recipients,cc,subject,body_key,search_text,sent_at,gmail_thread_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      messageId,
      job.conversation_id,
      job.mailbox_id,
      gmailId,
      job.message_id,
      job.kind === "auto" ? "auto" : "outbound",
      inbox.address,
      inbox.from_name,
      JSON.stringify(payload.to),
      JSON.stringify(payload.cc),
      payload.subject,
      bodyKey,
      payload.text.slice(0, 100000),
      timestamp,
      threadId,
    ),
    env.DB.prepare(
      "UPDATE outgoing SET state='sent',gmail_id=?,error=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
    ).bind(gmailId, timestamp, job.id),
    env.DB.prepare(
      "UPDATE conversations SET revision=revision+1,gmail_thread_id=COALESCE(gmail_thread_id,?),status=CASE WHEN ?<>'auto' AND last_inbound_id IS ? THEN ? ELSE status END,updated_at=MAX(updated_at,?) WHERE id=?",
    ).bind(
      threadId,
      job.kind,
      job.last_inbound_id,
      job.desired_status,
      timestamp,
      job.conversation_id,
    ),
  ];
  for (const a of payload.attachment_ids) {
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO message_attachments VALUES (?,?)",
      ).bind(messageId, a),
    );
    stmts.push(
      env.DB.prepare(
        "UPDATE attachments SET conversation_id=?,message_id=COALESCE(message_id,?) WHERE id=?",
      ).bind(job.conversation_id, messageId, a),
    );
  }
  stmts.push(
    env.DB.prepare("INSERT OR IGNORE INTO thread_links VALUES (?,?,?)").bind(
      job.mailbox_id,
      threadId,
      job.conversation_id,
    ),
  );
  await env.DB.batch(stmts);
}
export async function reconcileOutgoing(
  env: AppEnv,
  job: Outgoing,
  token?: string,
) {
  const t =
    token || (await accessToken(env, await getMailbox(env, job.mailbox_id)));
  const match = await gmail<{ messages?: { id: string; threadId: string }[] }>(
    t,
    `messages?q=${encodeURIComponent(`in:sent rfc822msgid:${job.message_id}`)}&maxResults=10`,
  );
  if (match.messages?.length) {
    await markSent(env, job, match.messages[0].id, match.messages[0].threadId);
    return true;
  }
  return false;
}
export async function sendOutgoing(env: AppEnv, id: string) {
  if (
    (await setting(env, "sending_enabled")) !== "true" ||
    (await setting(env, "restore_reconciled")) !== "true"
  )
    return;
  let job = await one<Outgoing>(
    env.DB,
    "SELECT * FROM outgoing WHERE id=?",
    id,
  );
  if (!job || job.state === "sent" || job.state === "failed") return;
  if (job.state === "uncertain") {
    await reconcileOutgoing(env, job);
    return;
  }
  if (job.state === "sending") {
    if (now() - job.updated_at > 120000) {
      await run(
        env.DB,
        "UPDATE outgoing SET state='uncertain',error='Send was interrupted. Checking Gmail before another attempt.',updated_at=? WHERE id=? AND state='sending'",
        now(),
        id,
      );
      await reconcileOutgoing(env, job);
    }
    return;
  }
  const lock = uid();
  const acquired = await run(
    env.DB,
    "UPDATE outgoing SET lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND state='pending' AND next_attempt_at<=? AND lease_until<?",
    lock,
    now() + 90000,
    now(),
    id,
    now(),
    now(),
  );
  if (!acquired.meta.changes) return;
  let attemptedSend = false;
  try {
    job = (await one<Outgoing>(
      env.DB,
      "SELECT * FROM outgoing WHERE id=?",
      id,
    ))!;
    const mailbox = await getMailbox(env, job.mailbox_id);
    const token = await accessToken(env, mailbox);
    if (await reconcileOutgoing(env, job, token)) return;
    const payload = JSON.parse(job.payload) as ComposePayload;
    const inbox = (await one<Inbox>(
      env.DB,
      "SELECT * FROM inboxes WHERE id=?",
      payload.inbox_id,
    ))!;
    const messages =
      payload.kind === "reply" || payload.kind === "auto"
        ? await all<Message>(
            env.DB,
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,id DESC",
            job.conversation_id,
          )
        : [];
    // A branded subject can start a second Gmail thread, still linked to one ticket.
    const matching = messages.find(
      (m) => m.gmail_thread_id && sameEmailSubject(m.subject, payload.subject),
    );
    const previous = matching || messages[0];
    const attachments: MimeAttachment[] = [];
    for (const attachmentId of payload.attachment_ids) {
      const a = await one<Attachment>(
        env.DB,
        "SELECT * FROM attachments WHERE id=?",
        attachmentId,
      );
      if (!a) throw new AppError(400, "Attachment is missing.");
      const object = await env.FILES.get(a.object_key);
      if (!object) throw new AppError(400, "Attachment data is missing.");
      attachments.push({
        filename: a.filename,
        contentType: a.content_type,
        data: new Uint8Array(await object.arrayBuffer()),
        contentId: a.content_id || undefined,
      });
    }
    const raw = buildMime(
      { ...payload, html: await outgoingHtml(env, job.id, payload.html) },
      inbox.from_name,
      inbox.address,
      job.message_id,
      {
        id: previous?.rfc_message_id || undefined,
        references: previous
          ? parseJson<Record<string, string>>(previous.headers, {}).references
          : undefined,
      },
      attachments,
      job.kind === "auto",
    );
    if (
      (await setting(env, "sending_enabled")) !== "true" ||
      (await setting(env, "restore_reconciled")) !== "true"
    )
      return;
    const claim = await run(
      env.DB,
      "UPDATE outgoing SET state='sending',attempts=attempts+1,updated_at=? WHERE id=? AND state='pending' AND lease_owner=? AND lease_until>? AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=outgoing.conversation_id AND c.deleted_at IS NULL)",
      now(),
      id,
      lock,
      now(),
    );
    if (!claim.meta.changes) return;
    attemptedSend = true;
    const sent = await gmail<{ id: string; threadId: string }>(
      token,
      "messages/send",
      {
        method: "POST",
        body: JSON.stringify({
          raw,
          ...(matching?.gmail_thread_id
            ? { threadId: matching.gmail_thread_id }
            : {}),
        }),
      },
    );
    await markSent(env, job, sent.id, sent.threadId);
  } catch (e) {
    const safe =
      e instanceof GoogleError && [400, 401, 403, 429].includes(e.status);
    const uncertain = attemptedSend && !safe;
    const attempts = job.attempts + 1;
    const retry =
      !uncertain &&
      (!(e instanceof AppError) || e.status >= 500 || e.status === 429) &&
      attempts < 5;
    await run(
      env.DB,
      "UPDATE outgoing SET state=?,attempts=CASE WHEN state='pending' THEN attempts+1 ELSE attempts END,error=?,next_attempt_at=?,updated_at=? WHERE id=? AND state<>'sent' AND lease_owner=?",
      uncertain ? "uncertain" : retry ? "pending" : "failed",
      uncertain
        ? "Send outcome is uncertain. Reconcile with Gmail before retrying."
        : e instanceof AppError
          ? e.message
          : "Provider is unavailable. Retry is scheduled.",
      now() + Math.min(600000, 30000 * 2 ** attempts),
      now(),
      id,
      lock,
    );
  } finally {
    await run(
      env.DB,
      "UPDATE outgoing SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?",
      id,
      lock,
    );
  }
}
export async function pendingJobs(env: AppEnv) {
  return all<Outgoing>(
    env.DB,
    "SELECT * FROM outgoing WHERE ((state='pending' AND next_attempt_at<=?) OR state='uncertain' OR (state='sending' AND updated_at<?)) AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=outgoing.conversation_id AND c.deleted_at IS NULL) ORDER BY created_at LIMIT 30",
    now(),
    now() - 120000,
  );
}
