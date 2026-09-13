import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import type {
  Attachment,
  Contact,
  Conversation,
  Message,
  Outgoing,
} from "../../shared/types";
import { all, AppError, now, one, recordEvent, run, uid } from "../db";
import { customerIntegration } from "../integrations";
import { cleanHtml, emailCsp, emailDocument, textToHtml } from "../mail";
import { composeSchema, enqueueOutgoing, reconcileOutgoing } from "../outbox";
export const conversationRoutes = new Hono<Bindings>();
const conversationSelect =
  "SELECT c.*,p.name contact_name,p.email contact_email,i.name inbox_name FROM conversations c JOIN contacts p ON p.id=c.contact_id JOIN inboxes i ON i.id=c.inbox_id";
conversationRoutes.get("/conversations/unread-count", async (c) => {
  const result = await one<{ unread_count: number }>(
    c.env.DB,
    "SELECT COUNT(*) unread_count FROM conversations WHERE unread=1 AND deleted_at IS NULL",
  );
  return c.json({ unread_count: result!.unread_count });
});
conversationRoutes.get("/conversations/counts", async (c) => {
  const inbox = c.req.query("inbox");
  const rows = await all<{ status: string; count: number }>(
    c.env.DB,
    `SELECT CASE WHEN deleted_at IS NOT NULL THEN 'trash' ELSE status END status,COUNT(*) count FROM conversations${inbox ? " WHERE inbox_id=?" : ""} GROUP BY CASE WHEN deleted_at IS NOT NULL THEN 'trash' ELSE status END`,
    ...(inbox ? [inbox] : []),
  );
  return c.json(Object.fromEntries(rows.map((row) => [row.status, row.count])));
});
conversationRoutes.get("/conversations", async (c) => {
  const inbox = c.req.query("inbox"),
    status = c.req.query("status"),
    q = c.req.query("q")?.slice(0, 150),
    offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const where: string[] = [
      status === "trash" ? "c.deleted_at IS NOT NULL" : "c.deleted_at IS NULL",
    ],
    params: unknown[] = [];
  if (inbox) {
    where.push("c.inbox_id=?");
    params.push(inbox);
  }
  if (status && ["open", "waiting", "closed"].includes(status)) {
    where.push("c.status=?");
    params.push(status);
  }
  if (q) {
    where.push(
      "(c.subject LIKE ? OR p.email LIKE ? OR p.name LIKE ? OR CAST(c.number AS TEXT)=? OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND (m.search_text LIKE ? OR m.subject LIKE ?)))",
    );
    params.push(
      `%${q}%`,
      `%${q}%`,
      `%${q}%`,
      q.replace(/^#/, ""),
      `%${q}%`,
      `%${q}%`,
    );
  }
  const items = await all<Conversation>(
    c.env.DB,
    `${conversationSelect}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY c.updated_at DESC LIMIT 51 OFFSET ?`,
    ...params,
    offset,
  );
  return c.json({
    items: items.slice(0, 50),
    has_more: items.length > 50,
  });
});
conversationRoutes.post("/conversations/bulk", async (c) => {
  const { action, items } = z
    .object({
      action: z.enum([
        "open",
        "waiting",
        "closed",
        "read",
        "unread",
        "trash",
        "restore",
      ]),
      items: z
        .array(
          z
            .object({
              id: z.string().min(1).max(160),
              revision: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .min(1)
        .max(50)
        .refine(
          (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
          "Choose each conversation only once.",
        ),
    })
    .strict()
    .parse(await c.req.json());
  const timestamp = now();
  const values: unknown[] = [];
  let change: string;
  if (action === "trash") {
    change = "deleted_at=?";
    values.push(timestamp);
  } else if (action === "restore") change = "deleted_at=NULL";
  else if (action === "read" || action === "unread") {
    change = "unread=?";
    values.push(Number(action === "unread"));
  } else {
    change = "status=?";
    values.push(action);
  }
  const guard =
    action === "restore" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  const sendGuard =
    action === "trash"
      ? " AND NOT EXISTS(SELECT 1 FROM outgoing o WHERE o.conversation_id=conversations.id AND o.state IN ('pending','sending','uncertain'))"
      : "";
  const results = await c.env.DB.batch<{ id: string }>(
    items.map((item) =>
      c.env.DB.prepare(
        `UPDATE conversations SET ${change},revision=revision+1 WHERE id=? AND revision=? AND ${guard}${sendGuard} RETURNING id`,
      ).bind(...values, item.id, item.revision),
    ),
  );
  const updated = results.flatMap((result) =>
    result.results.map((row) => row.id),
  );
  const skipped = items
    .filter((item) => !updated.includes(item.id))
    .map((item) => ({
      id: item.id,
      reason:
        action === "trash"
          ? "Changed since selection or has an unfinished send."
          : "Changed since selection or no longer in this folder.",
    }));
  return c.json({ updated, skipped });
});
conversationRoutes.get("/conversations/:id", async (c) => {
  const conversation = await one<Conversation>(
    c.env.DB,
    `${conversationSelect} WHERE c.id=?`,
    c.req.param("id"),
  );
  if (!conversation) throw new AppError(404, "Conversation not found.");
  const messages = await all<Message>(
    c.env.DB,
    "SELECT m.*,mo.first_opened_at,CASE WHEN mo.outgoing_id IS NULL THEN 0 ELSE 1 END open_tracked FROM messages m LEFT JOIN outgoing o ON o.message_id=m.rfc_message_id AND o.mailbox_id=m.mailbox_id LEFT JOIN message_opens mo ON mo.outgoing_id=o.id WHERE m.conversation_id=? ORDER BY m.sent_at,m.id",
    conversation.id,
  );
  const attachments = await all<Attachment>(
    c.env.DB,
    "SELECT a.id,a.conversation_id,ma.message_id,a.object_key,a.filename,a.content_type,a.size,a.content_id,a.created_at FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id JOIN messages m ON m.id=ma.message_id WHERE m.conversation_id=? UNION SELECT a.* FROM attachments a WHERE a.conversation_id=? AND NOT EXISTS(SELECT 1 FROM message_attachments ma WHERE ma.attachment_id=a.id)",
    conversation.id,
    conversation.id,
  );
  for (const message of messages)
    message.attachments = attachments.filter(
      (a) => a.message_id === message.id,
    );
  const contact = (await one<Contact>(
    c.env.DB,
    "SELECT * FROM contacts WHERE id=?",
    conversation.contact_id,
  ))!;
  const history = await all<Conversation>(
    c.env.DB,
    `${conversationSelect} WHERE c.contact_id=? AND c.id<>? AND c.deleted_at IS NULL ORDER BY c.updated_at DESC LIMIT 50`,
    conversation.contact_id,
    conversation.id,
  );
  const jobs = await all<Outgoing>(
    c.env.DB,
    "SELECT id,kind,state,error,attempts,created_at,updated_at FROM outgoing WHERE conversation_id=? AND state<>'sent' ORDER BY created_at",
    conversation.id,
  );
  const events = await all(
    c.env.DB,
    "SELECT kind,detail,created_at FROM events WHERE entity_id=? AND kind='delivery_failure' ORDER BY created_at DESC LIMIT 10",
    conversation.id,
  );
  return c.json({ conversation, messages, contact, history, jobs, events });
});
conversationRoutes.patch("/conversations/:id", async (c) => {
  const body = z
    .object({
      status: z.enum(["open", "waiting", "closed"]).optional(),
      unread: z.boolean().optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (
    !(await one(
      c.env.DB,
      "SELECT id FROM conversations WHERE id=?",
      c.req.param("id"),
    ))
  )
    throw new AppError(404, "Conversation not found.");
  await run(
    c.env.DB,
    "UPDATE conversations SET status=COALESCE(?,status),unread=COALESCE(?,unread),revision=revision+1 WHERE id=? AND deleted_at IS NULL AND (status IS NOT COALESCE(?,status) OR unread IS NOT COALESCE(?,unread))",
    body.status ?? null,
    body.unread === undefined ? null : Number(body.unread),
    c.req.param("id"),
    body.status ?? null,
    body.unread === undefined ? null : Number(body.unread),
  );
  return c.json({ ok: true });
});
conversationRoutes.get("/messages/:id/render", async (c) => {
  const message = await one<Message>(
    c.env.DB,
    "SELECT * FROM messages WHERE id=?",
    c.req.param("id"),
  );
  if (!message) throw new AppError(404, "Message not found.");
  const object = await c.env.FILES.get(message.body_key);
  if (!object) throw new AppError(404, "Message body is unavailable.");
  const body = await object.json<{ html: string; text: string }>();
  const images: Record<string, string> = {};
  const inline = await all<Attachment>(
    c.env.DB,
    "SELECT a.* FROM attachments a WHERE a.content_id IS NOT NULL AND (a.message_id=? OR a.id IN (SELECT attachment_id FROM message_attachments WHERE message_id=?))",
    message.id,
    message.id,
  );
  let size = 0;
  for (const a of inline) {
    if (
      !/^image\/(png|jpeg|gif|webp)$/.test(a.content_type) ||
      size + a.size > 8 * 1024 * 1024
    )
      continue;
    const image = await c.env.FILES.get(a.object_key);
    if (image) {
      images[a.content_id!] =
        `data:${a.content_type};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
      size += a.size;
    }
  }
  const remoteImages = c.req.query("images") === "show";
  c.header("Content-Security-Policy", emailCsp(remoteImages));
  return c.html(
    emailDocument(
      cleanHtml(
        body.html || textToHtml(body.text),
        images,
        false,
        remoteImages,
      ),
      remoteImages,
    ),
  );
});
conversationRoutes.get("/messages/:id/text", async (c) => {
  const m = await one<Message>(
    c.env.DB,
    "SELECT * FROM messages WHERE id=?",
    c.req.param("id"),
  );
  if (!m) throw new AppError(404, "Message not found.");
  const object = await c.env.FILES.get(m.body_key);
  if (!object) throw new AppError(404, "Message body unavailable.");
  const body = await object.json<{ html: string; text: string }>();
  return c.json({ text: body.text || m.search_text });
});
conversationRoutes.post("/attachments", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (
    !(file instanceof File) ||
    file.size === 0 ||
    file.size > 15 * 1024 * 1024
  )
    throw new AppError(400, "Choose a file between 1 byte and 15 MB.");
  const conversationId =
    typeof form.get("conversation_id") === "string"
      ? String(form.get("conversation_id"))
      : null;
  if (
    conversationId &&
    !(await one(
      c.env.DB,
      "SELECT id FROM conversations WHERE id=?",
      conversationId,
    ))
  )
    throw new AppError(404, "Conversation not found.");
  const inline = form.get("inline") === "1";
  if (inline && !/^image\/(png|jpeg|gif|webp)$/.test(file.type))
    throw new AppError(400, "Inline images must be PNG, JPEG, GIF or WebP.");
  const id = uid(),
    key = `uploads/${id}`;
  await c.env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const a: Attachment = {
    id,
    conversation_id: conversationId,
    message_id: null,
    object_key: key,
    filename: file.name.replace(/[\r\n]/g, "").slice(0, 200),
    content_type: file.type || "application/octet-stream",
    size: file.size,
    content_id: inline ? `${id}@smart-inbox` : null,
    created_at: now(),
  };
  await run(
    c.env.DB,
    "INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?)",
    a.id,
    a.conversation_id,
    a.message_id,
    a.object_key,
    a.filename,
    a.content_type,
    a.size,
    a.content_id,
    a.created_at,
  );
  return c.json(a);
});
conversationRoutes.get("/attachments/:id/inline", async (c) => {
  const a = await one<Attachment>(
    c.env.DB,
    "SELECT * FROM attachments WHERE id=?",
    c.req.param("id"),
  );
  if (!a || !/^image\/(png|jpeg|gif|webp)$/.test(a.content_type))
    throw new AppError(404, "Inline image not found.");
  const file = await c.env.FILES.get(a.object_key);
  if (!file) throw new AppError(404, "Image data unavailable.");
  return new Response(file.body, {
    headers: {
      "Content-Type": a.content_type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});
conversationRoutes.get("/attachments/:id", async (c) => {
  const a = await one<Attachment>(
    c.env.DB,
    "SELECT * FROM attachments WHERE id=?",
    c.req.param("id"),
  );
  if (!a) throw new AppError(404, "Attachment not found.");
  const file = await c.env.FILES.get(a.object_key);
  if (!file) throw new AppError(404, "Attachment data unavailable.");
  return new Response(file.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.filename).replace(/'/g, "%27")}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
conversationRoutes.post("/send", async (c) => {
  const payload = composeSchema.parse(await c.req.json());
  if (payload.kind === "auto")
    throw new AppError(400, "Automatic replies are managed by the server.");
  return c.json(await enqueueOutgoing(c.env, payload), 202);
});
conversationRoutes.post("/outgoing/:id/reconcile", async (c) => {
  const job = await one<Outgoing>(
    c.env.DB,
    "SELECT * FROM outgoing WHERE id=?",
    c.req.param("id"),
  );
  if (!job) throw new AppError(404, "Send job not found.");
  return c.json({ found: await reconcileOutgoing(c.env, job) });
});
conversationRoutes.post("/outgoing/:id/retry", async (c) => {
  const job = await one<Outgoing>(
    c.env.DB,
    "SELECT * FROM outgoing WHERE id=?",
    c.req.param("id"),
  );
  if (!job) throw new AppError(404, "Send job not found.");
  if (!["failed", "uncertain"].includes(job.state))
    throw new AppError(
      409,
      "This send cannot be retried in its current state.",
    );
  if (await reconcileOutgoing(c.env, job))
    return c.json({ ok: true, already_sent: true });
  const body = z
    .object({ verified_not_sent: z.boolean().default(false) })
    .parse(await c.req.json());
  if (job.state === "uncertain" && !body.verified_not_sent)
    throw new AppError(
      409,
      "Check Gmail Sent and explicitly confirm the message was not sent.",
    );
  const retried = await run(
    c.env.DB,
    "UPDATE outgoing SET state='pending',error=NULL,next_attempt_at=0,attempts=0,updated_at=? WHERE id=? AND state IN ('failed','uncertain') AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=outgoing.conversation_id AND c.deleted_at IS NULL)",
    now(),
    job.id,
  );
  if (!retried.meta.changes)
    throw new AppError(
      409,
      "Restore this conversation from Trash before retrying.",
    );
  await recordEvent(
    c.env,
    "send_retry",
    job.id,
    body.verified_not_sent
      ? "Owner verified Gmail Sent before retry."
      : "Retry of a known failed send.",
  );
  await c.env.JOBS.send({ type: "send", outgoingId: job.id });
  return c.json({ ok: true });
});
conversationRoutes.get("/contacts/:id/integrations/:provider", async (c) => {
  const provider = z
    .enum(["freemius", "mailchimp"])
    .parse(c.req.param("provider"));
  const contact = await one<Contact>(
    c.env.DB,
    "SELECT * FROM contacts WHERE id=?",
    c.req.param("id"),
  );
  if (!contact) throw new AppError(404, "Contact not found.");
  return c.json(
    await customerIntegration(
      c.env,
      contact,
      provider,
      c.req.query("refresh") === "1",
    ),
  );
});
conversationRoutes.put("/contacts/:id/freemius-link", async (c) => {
  const body = z
    .object({ email: z.string().email().toLowerCase().nullable() })
    .parse(await c.req.json());
  const contact = await one<Contact>(
    c.env.DB,
    "SELECT * FROM contacts WHERE id=?",
    c.req.param("id"),
  );
  if (!contact) throw new AppError(404, "Contact not found.");
  if (body.email) {
    const result = await customerIntegration(
      c.env,
      { ...contact, freemius_email: body.email },
      "freemius",
      true,
    );
    if (result.state !== "matched") {
      await run(
        c.env.DB,
        "DELETE FROM integration_snapshots WHERE contact_id=? AND provider='freemius'",
        contact.id,
      );
      throw new AppError(
        400,
        result.error || "No Freemius customer matched this address.",
      );
    }
  }
  await run(
    c.env.DB,
    "UPDATE contacts SET freemius_email=? WHERE id=?",
    body.email,
    contact.id,
  );
  await run(
    c.env.DB,
    "DELETE FROM integration_snapshots WHERE contact_id=? AND provider='freemius'",
    contact.id,
  );
  return c.json({ ok: true });
});
