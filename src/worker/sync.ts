import { workspaceSettings } from "./workspace";
import { queueDraft } from "./ai/jobs";
import type { Email } from "postal-mime";
import type { AppEnv } from "./env";
import type {
  Contact,
  Conversation,
  Inbox,
  Message,
  Outgoing,
} from "../shared/types";
import { supportSubject } from "../shared/subjects";
import { DEFAULT_ACK } from "../shared/types";
import {
  all,
  AppError,
  normalizeEmail,
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
  type ConnectedMailbox,
  decodeMessage,
  getMailbox,
  gmail,
  type GmailMessage,
  GoogleError,
} from "./google";
import {
  addresses,
  cleanHtml,
  customerIdentity,
  shouldAcknowledge,
  template,
  textToHtml,
} from "./mail";
import { sha256 } from "./secrets";
import { enqueueOutgoing, markSent } from "./outbox";

export function routeInbox(inboxes: Inbox[], mailboxId: string, mail: Email) {
  const candidates = inboxes
    .filter((i) => i.mailbox_id === mailboxId)
    .sort(
      (a, b) =>
        a.routing_priority - b.routing_priority || a.id.localeCompare(b.id),
    );
  const recipients = [
    ...addresses(mail.to),
    ...addresses(mail.cc),
    normalizeEmail(mail.deliveredTo || ""),
  ];
  return (
    candidates.find((i) => recipients.includes(i.address)) || candidates[0]
  );
}
async function acknowledgement(
  env: AppEnv,
  conversation: Conversation,
  inbox: Inbox,
  mail: Email,
  support: string[],
  receivedAt: number,
) {
  if (
    conversation.deleted_at !== null ||
    (await setting(env, "acknowledgements_enabled")) !== "true" ||
    (await setting(env, "sending_enabled")) !== "true" ||
    now() - receivedAt > 24 * 3600000 ||
    !shouldAcknowledge(mail, inbox, support, new Date(receivedAt))
  )
    return;
  const counts = await one<{ incoming: number; outgoing: number }>(
    env.DB,
    "SELECT SUM(direction='inbound') incoming,SUM(direction='outbound') outgoing FROM messages WHERE conversation_id=?",
    conversation.id,
  );
  if (counts?.incoming !== 1 || counts.outgoing > 0) return;
  const contact = (await one<Contact>(
    env.DB,
    "SELECT * FROM contacts WHERE id=?",
    conversation.contact_id,
  ))!;
  const text = template(inbox.auto_reply || DEFAULT_ACK, {
    "customer.firstName":
      contact.name === contact.email ? "" : contact.name.split(" ")[0],
    "customer.fullName": contact.name,
    "customer.email": contact.email,
    "inbox.name": inbox.name,
    "ticket.number": String(conversation.number),
  });
  await enqueueOutgoing(env, {
    inbox_id: inbox.id,
    conversation_id: conversation.id,
    to: addresses(mail.replyTo).length
      ? addresses(mail.replyTo)
      : [contact.email],
    cc: [],
    bcc: [],
    subject: conversation.subject,
    html: textToHtml(text),
    text,
    attachment_ids: [],
    kind: "auto",
    status: "open",
    idempotency_key: `auto:${conversation.id}`,
  });
}
export async function ingestMessage(
  env: AppEnv,
  mailbox: ConnectedMailbox,
  token: string,
  gm: GmailMessage,
  inboxes: Inbox[],
  renew = async () => {},
) {
  const receivedAt = Number(gm.internalDate);
  if (
    receivedAt < mailbox.cutover_at ||
    gm.labelIds.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l))
  )
    return;
  const mail = await decodeMessage(token, gm, renew);
  await renew();
  const headers = Object.fromEntries(mail.headers.map((h) => [h.key, h.value]));
  if (gm.labelIds.includes("SENT") && mail.messageId) {
    const job = await one<Outgoing>(
      env.DB,
      "SELECT * FROM outgoing WHERE mailbox_id=? AND message_id=?",
      mailbox.id,
      mail.messageId,
    );
    if (job) {
      await markSent(env, job, gm.id, gm.threadId);
      return;
    }
  }
  const existing = await one<Message>(
    env.DB,
    "SELECT * FROM messages WHERE mailbox_id=? AND gmail_id=?",
    mailbox.id,
    gm.id,
  );
  const support = [
    mailbox.email,
    ...inboxes.map((i) => i.address),
    ...parseJson<{ sendAsEmail: string }[]>(mailbox.aliases, []).map((a) =>
      normalizeEmail(a.sendAsEmail),
    ),
  ];
  if (existing) {
    if (existing.direction === "inbound") {
      const c = await one<Conversation>(
        env.DB,
        "SELECT * FROM conversations WHERE id=?",
        existing.conversation_id,
      );
      const inbox = inboxes.find((i) => i.id === c?.inbox_id);
      if (c && inbox) {
        await acknowledgement(env, c, inbox, mail, support, receivedAt);
        await scheduleDraft(env, c.id);
      }
    }
    return;
  }
  const isSent = gm.labelIds.includes("SENT");
  let conversation =
    (await one<Conversation>(
      env.DB,
      "SELECT c.* FROM thread_links t JOIN conversations c ON c.id=t.conversation_id WHERE t.mailbox_id=? AND t.thread_id=?",
      mailbox.id,
      gm.threadId,
    )) ||
    (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE mailbox_id=? AND gmail_thread_id=?",
      mailbox.id,
      gm.threadId,
    ));
  const bounce =
    /multipart\/report|delivery-status/i.test(headers["content-type"] || "") ||
    /mailer-daemon|postmaster/i.test(mail.from?.address || "");
  if (!conversation) {
    const refs = [
      mail.inReplyTo || "",
      mail.references || "",
      headers["original-message-id"] || "",
    ];
    if (bounce)
      for (const a of mail.attachments) {
        if (/delivery-status|rfc822/.test(a.mimeType)) {
          const content =
            typeof a.content === "string"
              ? a.content
              : Buffer.from(
                  a.content instanceof Uint8Array
                    ? a.content
                    : new Uint8Array(a.content),
                ).toString("utf8");
          refs.push(content.slice(0, 20000));
        }
      }
    const ids = refs.join(" ").match(/<[^<>\s]+@[^<>\s]+>/g) || [];
    for (const ref of ids.reverse().slice(0, 30)) {
      const previous = await one<{ conversation_id: string }>(
        env.DB,
        "SELECT conversation_id FROM messages WHERE mailbox_id=? AND rfc_message_id=? LIMIT 1",
        mailbox.id,
        ref,
      );
      if (previous) {
        conversation = await one<Conversation>(
          env.DB,
          "SELECT * FROM conversations WHERE id=?",
          previous.conversation_id,
        );
        break;
      }
    }
  }
  const inbox = conversation
    ? inboxes.find((i) => i.id === conversation!.inbox_id)
    : routeInbox(inboxes, mailbox.id, mail);
  if (!inbox) return;
  const direction =
    headers["auto-submitted"] === "auto-replied" &&
    support.includes(normalizeEmail(mail.from?.address || ""))
      ? "auto"
      : isSent
        ? "outbound"
        : "inbound";
  const customer = customerIdentity(mail, support, isSent);
  if (!customer) return;
  const { email: contactEmail, name: contactName } = customer;
  let contactId = await sha256(`contact:${contactEmail}`);
  await run(
    env.DB,
    "INSERT INTO contacts(id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=CASE WHEN contacts.name=contacts.email THEN excluded.name ELSE contacts.name END",
    contactId,
    contactEmail,
    contactName,
    receivedAt,
  );
  contactId = (await one<{ id: string }>(
    env.DB,
    "SELECT id FROM contacts WHERE email=?",
    contactEmail,
  ))!.id;
  if (!conversation) {
    const id = await sha256(`thread:${mailbox.id}:${gm.threadId}`);
    const number = (await one<{ value: number }>(
      env.DB,
      "UPDATE counters SET value=value+1 WHERE name='ticket' RETURNING value",
    ))!.value;
    // Header references indicate context predating our local conversation, without importing that context.
    const missing = mail.inReplyTo || mail.references ? 1 : 0;
    await run(
      env.DB,
      "INSERT OR IGNORE INTO conversations(id,number,inbox_id,contact_id,mailbox_id,gmail_thread_id,subject,status,unread,history_missing,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      number,
      inbox.id,
      contactId,
      mailbox.id,
      gm.threadId,
      supportSubject(
        mail.subject || "(No subject)",
        await workspaceSettings(env),
      ),
      isSent ? inbox.default_status : "open",
      isSent ? 0 : 1,
      missing,
      receivedAt,
      receivedAt,
    );
    conversation = (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE mailbox_id=? AND gmail_thread_id=?",
      mailbox.id,
      gm.threadId,
    ))!;
  }
  const messageId = await sha256(`message:${mailbox.id}:${gm.id}`),
    bodyKey = `messages/${messageId}.json`;
  const attachmentStatements: D1PreparedStatement[] = [];
  for (let i = 0; i < mail.attachments.length; i++) {
    const a = mail.attachments[i],
      id = await sha256(`${messageId}:${i}`),
      key = `attachments/${id}`;
    const data =
      typeof a.content === "string"
        ? Buffer.from(a.content, a.encoding === "base64" ? "base64" : "utf8")
        : a.content;
    await renew();
    await env.FILES.put(key, data, {
      httpMetadata: { contentType: a.mimeType },
    });
    attachmentStatements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO attachments VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        conversation.id,
        messageId,
        key,
        a.filename || "attachment",
        a.mimeType,
        typeof data === "string" ? Buffer.byteLength(data) : data.byteLength,
        a.contentId?.replace(/[<>]/g, "") || null,
        receivedAt,
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO message_attachments VALUES (?,?)",
      ).bind(messageId, id),
    );
  }
  await env.FILES.put(
    bodyKey,
    JSON.stringify({
      html: mail.html || textToHtml(mail.text || ""),
      text: mail.text || "",
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  const search =
    mail.text || cleanHtml(mail.html || "").replace(/<[^>]*>/g, " ");
  const snippet = search.replace(/\s+/g, " ").slice(0, 180);
  const batch = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,conversation_id,mailbox_id,gmail_id,rfc_message_id,direction,sender,sender_name,recipients,cc,subject,body_key,search_text,headers,sent_at,gmail_thread_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      messageId,
      conversation.id,
      mailbox.id,
      gm.id,
      mail.messageId || null,
      direction,
      mail.from?.address || "",
      mail.from?.name || "",
      JSON.stringify(addresses(mail.to)),
      JSON.stringify(addresses(mail.cc)),
      mail.subject || "",
      bodyKey,
      search.slice(0, 100000),
      JSON.stringify({
        ...headers,
        "reply-to-addresses": JSON.stringify(addresses(mail.replyTo)),
      }),
      receivedAt,
      gm.threadId,
    ),
    ...attachmentStatements,
    env.DB.prepare("INSERT OR IGNORE INTO thread_links VALUES (?,?,?)").bind(
      mailbox.id,
      gm.threadId,
      conversation.id,
    ),
  ];
  if (direction === "inbound")
    batch.push(
      env.DB.prepare(
        "UPDATE conversations SET revision=revision+1,deleted_at=CASE WHEN deleted_at<? THEN NULL ELSE deleted_at END,status='open',unread=1,last_inbound_id=?,snippet=CASE WHEN updated_at<=? THEN ? ELSE snippet END,updated_at=MAX(updated_at,?) WHERE id=?",
      ).bind(
        receivedAt,
        messageId,
        receivedAt,
        snippet,
        receivedAt,
        conversation.id,
      ),
    );
  else if (direction === "outbound")
    batch.push(
      env.DB.prepare(
        "UPDATE conversations SET revision=revision+1,status=CASE WHEN updated_at<=? THEN ? ELSE status END,snippet=CASE WHEN updated_at<=? THEN ? ELSE snippet END,updated_at=MAX(updated_at,?) WHERE id=?",
      ).bind(
        receivedAt,
        inbox.default_status,
        receivedAt,
        snippet,
        receivedAt,
        conversation.id,
      ),
    );
  await renew();
  await env.DB.batch(batch);
  if (bounce) {
    await run(
      env.DB,
      "UPDATE conversations SET revision=revision+1,status='open',unread=1 WHERE id=?",
      conversation.id,
    );
    await recordEvent(
      env,
      "delivery_failure",
      conversation.id,
      "A delivery failure was received. Check the message before retrying.",
    );
  }
  if (direction === "inbound" && !bounce)
    await acknowledgement(
      env,
      { ...conversation, last_inbound_id: messageId },
      inbox,
      mail,
      support,
      receivedAt,
    );
  if (direction === "inbound" && !bounce)
    await scheduleDraft(env, conversation.id);
}
async function scheduleDraft(env: AppEnv, conversationId: string) {
  try {
    await queueDraft(env, conversationId);
  } catch {
    await recordEvent(
      env,
      "ai_schedule_failed",
      conversationId,
      "AI draft scheduling failed. Ticket receipt was preserved.",
    );
  }
}
interface HistoryPage {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  historyId: string;
  nextPageToken?: string;
}
export async function synchronize(env: AppEnv, mailboxId: string) {
  const lock = uid(),
    acquired = await run(
      env.DB,
      "UPDATE mailboxes SET lease_owner=?,lease_until=? WHERE id=? AND state='connected' AND lease_until<?",
      lock,
      now() + 120000,
      mailboxId,
      now(),
    );
  if (!acquired.meta.changes) return;
  try {
    const mailbox = await getMailbox(env, mailboxId);
    const token = await accessToken(env, mailbox);
    const inboxes = await all<Inbox>(
      env.DB,
      "SELECT * FROM inboxes WHERE mailbox_id IS NOT NULL",
    );
    if (!inboxes.some((i) => i.mailbox_id === mailboxId)) return;
    async function renew() {
      const r = await run(
        env.DB,
        "UPDATE mailboxes SET lease_until=? WHERE id=? AND lease_owner=? AND lease_until>?",
        now() + 120000,
        mailboxId,
        lock,
        now(),
      );
      if (!r.meta.changes)
        throw new AppError(409, "Mailbox synchronization lease expired.");
    }
    async function process(id: string) {
      await renew();
      try {
        const message = await gmail<GmailMessage>(
          token,
          `messages/${id}?format=full`,
        );
        await ingestMessage(env, mailbox, token, message, inboxes, renew);
      } catch (e) {
        if (e instanceof GoogleError && e.status === 404) return;
        throw e;
      }
    }
    let pageToken: string | undefined,
      cursor = mailbox.history_id;
    try {
      do {
        await renew();
        const page: HistoryPage = await gmail<HistoryPage>(
          token,
          `history?startHistoryId=${encodeURIComponent(mailbox.history_id)}&historyTypes=messageAdded&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );
        const ids = [
          ...new Set(
            page.history?.flatMap(
              (h) => h.messagesAdded?.map((x) => x.message.id) || [],
            ) || [],
          ),
        ];
        for (const id of ids) await process(id);
        cursor = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 404)) throw e;
      cursor = (await gmail<{ historyId: string }>(token, "profile")).historyId;
      pageToken = undefined;
      do {
        await renew();
        const page: { messages?: { id: string }[]; nextPageToken?: string } =
          await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(
            token,
            `messages?q=${encodeURIComponent(`after:${Math.floor(mailbox.cutover_at / 1000) - 1} -in:spam -in:trash -in:drafts`)}&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
          );
        for (const m of page.messages || []) await process(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    const saved = await run(
      env.DB,
      "UPDATE mailboxes SET history_id=?,last_sync_at=?,error=NULL WHERE id=? AND lease_owner=? AND lease_until>?",
      cursor,
      now(),
      mailboxId,
      lock,
      now(),
    );
    if (!saved.meta.changes)
      throw new AppError(
        409,
        "Synchronization was interrupted before saving the cursor.",
      );
  } catch (e) {
    await run(
      env.DB,
      "UPDATE mailboxes SET error=? WHERE id=? AND lease_owner=?",
      e instanceof AppError
        ? e.message
        : "Synchronization failed. It will be retried automatically.",
      mailboxId,
      lock,
    );
  } finally {
    await run(
      env.DB,
      "UPDATE mailboxes SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?",
      mailboxId,
      lock,
    );
  }
}
