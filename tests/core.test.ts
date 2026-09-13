import {
  DEFAULT_WORKSPACE,
  publicHttpsUrl,
  documentationLink,
} from "../src/shared/workspace";
const brand = {
  ...DEFAULT_WORKSPACE,
  name: "Northstar Support",
  product_name: "Northstar",
  subject_identifiers: ["northstar-plugin", "Northstar"],
};
const docsConfig = {
  ...DEFAULT_AI,
  documentation_index_url: "https://docs.example.com/llms.txt",
};
import { workspaceSettings } from "../src/worker/workspace";
import { DEFAULT_AI, type AIRun } from "../src/shared/ai";
import { replySchema, replyToHtml } from "../src/worker/ai/reply";
import {
  queueDraft,
  prepareRun,
  saveGeneratedDraft,
  recoverDraftJobs,
} from "../src/worker/ai/jobs";
import { paidEligibility, automatedReason } from "../src/worker/ai/eligibility";
import {
  searchDocs,
  searchCode,
  githubHead,
  allowedCodePath,
  syncDocumentation,
} from "../src/worker/ai/knowledge";
import {
  callbackFixture,
  structuredFixture,
} from "./fixtures/customer-sidebar";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { app } from "../src/worker/index";
import type { AppEnv } from "../src/worker/env";
import type {
  Contact,
  Conversation,
  Inbox,
  Outgoing,
  ComposePayload,
  ContactsResult,
  ContactHistory,
} from "../src/shared/types";
import { encrypt, decrypt, saveSecret } from "../src/worker/secrets";
import { all, one, run, setSetting } from "../src/worker/db";
import {
  buildMime,
  cleanHtml,
  customerIdentity,
  outsideOfficeHours,
  shouldAcknowledge,
  template,
} from "../src/worker/mail";
import {
  customerIntegration,
  entitlement,
  validateFreemiusCallback,
  validateSignatureHeader,
} from "../src/worker/integrations";
import {
  decodeMessage,
  type GmailMessage,
  getMailbox,
  verifiedSendingAddress,
} from "../src/worker/google";
import { ingestMessage, synchronize } from "../src/worker/sync";
import { enqueueOutgoing, markSent, sendOutgoing } from "../src/worker/outbox";
import { recoveryStatements } from "../scripts/recovery-sql.mjs";
import { sameEmailSubject, supportSubject } from "../src/shared/subjects";
import trackingWorker from "../src/worker/tracking-entry";
import { outgoingHtml } from "../src/worker/open-tracking";
import { backup, BACKUP_TABLES } from "../src/worker/backup";
let mf: Miniflare, env: AppEnv, inbox: Inbox;
const schema =
  (await readFile(
    new URL("../migrations/0001_initial.sql", import.meta.url),
    "utf8",
  )) +
  (await readFile(
    new URL("../migrations/0002_message_attachments.sql", import.meta.url),
    "utf8",
  )) +
  (await readFile(
    new URL("../migrations/0003_ticket_actions.sql", import.meta.url),
    "utf8",
  )) +
  (await readFile(
    new URL("../migrations/0004_ai_drafts.sql", import.meta.url),
    "utf8",
  )) +
  (await readFile(
    new URL("../migrations/0005_open_tracking.sql", import.meta.url),
    "utf8",
  )) +
  (await readFile(
    new URL("../migrations/0006_reports.sql", import.meta.url),
    "utf8",
  )) +
  (await readFile(
    new URL("../migrations/0007_conversation_merges.sql", import.meta.url),
    "utf8",
  ));
const contact: Contact = {
  id: "customer",
  email: "customer@example.test",
  name: "Test Customer",
  freemius_email: null,
  created_at: 1,
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(
    "http://localhost" + path,
    {
      method,
      headers: {
        Origin: env.APP_ORIGIN,
        "X-Support-Request": "1",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
function message(
  id: string,
  options: Partial<GmailMessage> = {},
  extra: { name: string; value: string }[] = [],
): GmailMessage {
  return {
    id,
    threadId: "thread",
    internalDate: String(Date.now()),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Test Customer <customer@example.test>" },
        { name: "To", value: "support@example.com" },
        { name: "Subject", value: "Test subject" },
        { name: "Message-ID", value: `<${id}@example.test>` },
        ...extra,
      ],
      body: { data: Buffer.from("Test message content").toString("base64url") },
    },
    ...options,
  };
}
async function incoming(id = "first") {
  await ingestMessage(
    env,
    await getMailbox(env, "mailbox"),
    "token",
    message(id),
    [inbox],
  );
  return (await one<Conversation>(
    env.DB,
    "SELECT * FROM conversations LIMIT 1",
  ))!;
}
function payload(c: Conversation, id = "test-idempotency"): ComposePayload {
  return {
    inbox_id: inbox.id,
    conversation_id: c.id,
    to: [contact.email],
    cc: [],
    bcc: [],
    subject: c.subject,
    text: "Reply",
    html: "<p>Reply</p>",
    attachment_ids: [],
    kind: "reply",
    status: "closed",
    idempotency_key: id,
  };
}
async function mockGoogle(
  send: () => Response | Promise<Response> = () =>
    json({ id: "sent-id", threadId: "thread" }),
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com"))
        return json({ access_token: "token" });
      if (url.includes("messages/send")) return send();
      if (url.includes("messages?q=")) return json({ messages: [] });
      throw Error("Unexpected provider URL: " + url);
    }),
  );
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        'export default {async fetch(request){try {const options=await request.json();const outbound=new Request("https://provider.example.test/",options);return Response.json({redirect:outbound.redirect});}catch(e){return Response.json({error:e.message},{status:500});}}}',
      compatibilityDate: "2026-09-12",
      d1Databases: ["DB"],
      r2Buckets: ["FILES", "BACKUPS"],
    }),
  );
  env = {
    DB: await mf.getD1Database("DB"),
    FILES: await mf.getR2Bucket("FILES"),
    BACKUPS: await mf.getR2Bucket("BACKUPS"),
    JOBS: { send: vi.fn(async () => {}) },
    ASSETS: { fetch: async () => new Response("private assets") },
    APP_ORIGIN: "http://localhost",
    OWNER_EMAIL: "owner@example.com",
    LOCAL_DEV_AUTH: "1",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
    WORKSPACE_DOMAIN: "example.com",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as AppEnv;
  env.AI_JOBS = env.JOBS;
  await env.DB.batch(
    schema
      .replace(
        /CREATE TRIGGER[\s\S]*?END;/g,
        (block) =>
          block.slice(0, -1).replaceAll(";", "__TRIGGER_SEPARATOR__") + ";",
      )
      .split(";")
      .map((x) => x.replaceAll("__TRIGGER_SEPARATOR__", ";"))
      .map((x) => x.trim())
      .filter(Boolean)
      .map((sql) => env.DB.prepare(sql)),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});
beforeEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch(
    [
      "oauth_states",
      ...BACKUP_TABLES.slice()
        .reverse()
        .filter((x) => x !== "settings"),
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await run(env.DB, "DELETE FROM settings");
  await run(env.DB, "INSERT INTO counters VALUES ('ticket',0)");
  await saveSecret(env, "google_client_secret", "client-secret");
  await setSetting(env, "google_client_id", "test-client");
  await setSetting(env, "workspace", JSON.stringify(brand));
  await setSetting(env, "freemius_product_id", "12345");
  await setSetting(env, "freemius_mode", "callback");
  await setSetting(env, "ai_config", JSON.stringify(docsConfig));
  await setSetting(
    env,
    "ai_docs_index_url",
    docsConfig.documentation_index_url,
  );
  await setSetting(env, "sending_enabled", "true");
  await setSetting(env, "acknowledgements_enabled", "false");
  await setSetting(env, "restore_reconciled", "true");
  await run(
    env.DB,
    "INSERT INTO mailboxes(id,email,refresh_token,history_id,cutover_at,aliases,created_at) VALUES ('mailbox','support@example.com',?,'100',1000,?,1)",
    await encrypt(env, "refresh-token"),
    JSON.stringify([{ sendAsEmail: "support@example.com", isPrimary: true }]),
  );
  await run(
    env.DB,
    "INSERT INTO inboxes(id,mailbox_id,name,address,from_name,created_at) VALUES ('inbox','mailbox','Northstar Support','support@example.com','Northstar',1)",
  );
  inbox = (await one<Inbox>(env.DB, "SELECT * FROM inboxes"))!;
  await run(
    env.DB,
    "INSERT INTO contacts(id,email,name,created_at) VALUES (?,?,?,?)",
    contact.id,
    contact.email,
    contact.name,
    1,
  );
});
describe("privacy and editing", () => {
  it("rejects untrusted hosts, forged identity and all unauthenticated resource paths", async () => {
    for (const path of [
      "/",
      "/api/me",
      "/api/ai/settings",
      "/api/ai/conversations/private",
      "/api/ai/sources/history/private",
      "/agents/support-draft-agent/private",
      "/api/conversations/unread-count",
      "/api/contacts",
      "/api/reports",
      "/api/reports/conversations",
      "/api/reports/export",
      "/api/contacts/private",
      "/assets/app.js",
      "/api/attachments/private",
      "/api/messages/private/render",
      "/api/google/callback",
    ]) {
      const res = await app.request(
        "https://production.example" + path,
        {},
        {
          ...env,
          APP_ORIGIN: "https://production.example",
          LOCAL_DEV_AUTH: undefined,
        },
      );
      expect(res.status).toBe(401);
    }
    expect(
      (
        await app.request(
          "https://preview.example/api/me",
          {},
          { ...env, LOCAL_DEV_AUTH: undefined },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          "https://production.example/api/me",
          {
            headers: {
              "Cf-Access-Jwt-Assertion": "forged",
              "Cf-Access-Authenticated-User-Email": "owner@example.com",
            },
          },
          {
            ...env,
            APP_ORIGIN: "https://production.example",
            LOCAL_DEV_AUTH: undefined,
          },
        )
      ).status,
    ).toBe(401);
  });
  it("rejects cross-origin mutations and missing CSRF marker", async () => {
    expect(
      (
        await request(
          "/api/settings",
          "PUT",
          {},
          { Origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/settings", "PUT", {}, { "X-Support-Request": "" }))
        .status,
    ).toBe(403);
  });
  it("encrypts credentials and fails with the wrong key", async () => {
    const value = await encrypt(env, "private-value");
    expect(value).not.toContain("private-value");
    expect(await decrypt(env, value)).toBe("private-value");
    await expect(
      decrypt(
        { ...env, ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64") },
        value,
      ),
    ).rejects.toThrow();
  });
  it("never returns saved credentials in settings", async () => {
    await saveSecret(env, "google_client_secret", "sensitive");
    const res = await request("/api/settings");
    expect(await res.text()).not.toContain("sensitive");
  });
  it("detects edits from two tabs", async () => {
    const draft = {
      version: 0,
      conversation_id: null,
      payload: { text: "one" },
    };
    expect((await request("/api/drafts/new", "PUT", draft)).status).toBe(200);
    expect((await request("/api/drafts/new", "PUT", draft)).status).toBe(409);
    expect(
      (await request("/api/drafts/new", "PUT", { ...draft, version: 1 }))
        .status,
    ).toBe(200);
    expect(
      (await request("/api/drafts/new", "PUT", { ...draft, version: 1 }))
        .status,
    ).toBe(409);
  });
  it("sanitizes hostile HTML and blocks remote images", () => {
    const html = cleanHtml(
      '<script>alert(1)</script><img src="https://tracker.example.com/pixel" onerror="evil()"><a href="javascript:evil()">Click</a><form>submit</form><img src="cid:photo">',
      { photo: "data:image/png;base64,eA==" },
    );
    expect(html).not.toMatch(/script|onerror|tracker.test|javascript|<form/);
    expect(html).toContain("data:image/png");
    expect(html).toContain("Remote image blocked");
  });
  it("preserves safe email layout while removing active CSS and hidden document metadata", () => {
    const html = cleanHtml(
      '<html><head><title>Duplicate subject</title><style>body{background:url(https://tracker.example.com)}</style></head><body><div style="display:none;height:0;overflow:hidden">Preview only</div><table width="640" style="width:640px;border-collapse:collapse"><tr><th align="left" style="font-weight:400;padding:12px 24px;text-align:left;background:url(https://tracker.example.com);position:fixed;left:0"><p style="color:#333333;font-size:14px;line-height:20px">Hello</p><a href="https://example.com" style="color:#0067b8">Help</a></th></tr></table></body></html>',
    );
    expect(html).toContain('width="640"');
    expect(html).toContain("font-weight:400;padding:12px 24px;text-align:left");
    expect(html).toContain("display:none;height:0;overflow:hidden");
    expect(html).toContain("color:#0067b8");
    expect(html).not.toMatch(
      /Duplicate subject|<style|tracker|position|left:0/,
    );
  });
  it("loads only explicitly requested HTTPS images and preserves inline dimensions", () => {
    const raw =
      '<img src="https://images.example.com/logo.png" alt="Logo" width="120" height="30" style="height:30px;width:auto" onload="evil()"><img src="http://localhost/secret"><img src="https://127.0.0.1/secret"><img src="https://images.example.com/open" width="1" height="1"><img src="cid:photo" width="200" height="100">';
    const blocked = cleanHtml(raw, { photo: "data:image/png;base64,eA==" });
    expect(blocked).not.toContain("https://images.example.com");
    expect(blocked).toContain('data-remote-image="true"');
    const shown = cleanHtml(
      raw,
      { photo: "data:image/png;base64,eA==" },
      false,
      true,
    );
    expect(shown).toContain('src="https://images.example.com/logo.png"');
    expect(shown).toContain("height:30px;width:auto");
    expect(shown).toContain('referrerpolicy="no-referrer"');
    expect(shown).toContain('width="200" height="100"');
    expect(shown).not.toMatch(/localhost|127\.0\.0\.1|onload|\/open/);
  });
  it("renders email in a private embeddable document", async () => {
    await incoming();
    const m = (await one<{ id: string }>(env.DB, "SELECT id FROM messages"))!;
    const res = await request(`/api/messages/${m.id}/render`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(await res.text()).toContain("Test message content");
  });
});
describe("optional open tracking", () => {
  const origin = "https://opens.example.com";
  it("requires a configured separate endpoint and explicit opt-in", async () => {
    const c = await incoming();
    const job = await enqueueOutgoing(env, payload(c));
    expect(await outgoingHtml(env, job.id, "<p>Reply</p>")).toBe(
      "<p>Reply</p>",
    );
    expect(await all(env.DB, "SELECT * FROM message_opens")).toHaveLength(0);
    expect(
      (await request("/api/operations", "PUT", { open_tracking_enabled: true }))
        .status,
    ).toBe(409);
  });
  it("keeps a stable pixel, records the first estimated open and exposes it only in the private thread", async () => {
    const tracked = { ...env, OPEN_TRACKING_ORIGIN: origin };
    await setSetting(env, "open_tracking_enabled", "true");
    const c = await incoming();
    const job = await enqueueOutgoing(tracked, payload(c));
    await enqueueOutgoing(tracked, payload(c));
    const rows = await all<{
      image_url: string;
      first_opened_at: number | null;
    }>(env.DB, "SELECT * FROM message_opens");
    expect(rows).toHaveLength(1);
    const html = await outgoingHtml(tracked, job.id, "<p>Reply</p>");
    expect(html).toContain(rows[0].image_url);
    expect(JSON.parse(job.payload).html).not.toContain("/o/");
    expect(cleanHtml(html, {}, false, true)).not.toContain("/o/");
    const get = () =>
      trackingWorker.fetch(new Request(rows[0].image_url), {
        ...env,
        APP_ORIGIN: origin,
      });
    const image = await get();
    expect(image.headers.get("Content-Type")).toBe("image/gif");
    expect(image.headers.get("Cache-Control")).toContain("no-store");
    const first = (await one<{ first_opened_at: number }>(
      env.DB,
      "SELECT first_opened_at FROM message_opens",
    ))!.first_opened_at;
    expect(first).toBeGreaterThan(0);
    await get();
    expect(
      (await one<{ first_opened_at: number }>(
        env.DB,
        "SELECT first_opened_at FROM message_opens",
      ))!.first_opened_at,
    ).toBe(first);
    const unknown = await trackingWorker.fetch(
      new Request(`${origin}/o/${"0".repeat(64)}.gif`),
      { ...env, APP_ORIGIN: origin },
    );
    expect(await unknown.arrayBuffer()).toEqual(await image.arrayBuffer());
    expect(
      (
        await trackingWorker.fetch(new Request(origin + "/api/conversations"), {
          ...env,
          APP_ORIGIN: origin,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await trackingWorker.fetch(
          new Request(rows[0].image_url, { method: "POST" }),
          { ...env, APP_ORIGIN: origin },
        )
      ).status,
    ).toBe(404);
    await markSent(env, job, "tracked-sent", "thread");
    const detail = (await (
      await request(`/api/conversations/${c.id}`)
    ).json()) as { messages: { direction: string; first_opened_at: number }[] };
    expect(
      detail.messages.find((m) => m.direction === "outbound")?.first_opened_at,
    ).toBe(first);
  });
  it("does not track acknowledgements, HEAD requests, disabled tracking or expired pixels", async () => {
    const tracked = { ...env, OPEN_TRACKING_ORIGIN: origin };
    await setSetting(env, "open_tracking_enabled", "true");
    const c = await incoming();
    await enqueueOutgoing(tracked, {
      ...payload(c, "auto-tracking-test"),
      kind: "auto",
    });
    expect(await all(env.DB, "SELECT * FROM message_opens")).toHaveLength(0);
    await enqueueOutgoing(tracked, payload(c));
    const row = (await one<{ image_url: string }>(
      env.DB,
      "SELECT image_url FROM message_opens",
    ))!;
    await trackingWorker.fetch(new Request(row.image_url, { method: "HEAD" }), {
      ...env,
      APP_ORIGIN: origin,
    });
    await setSetting(env, "open_tracking_enabled", "false");
    await trackingWorker.fetch(new Request(row.image_url), {
      ...env,
      APP_ORIGIN: origin,
    });
    await setSetting(env, "open_tracking_enabled", "true");
    await run(
      env.DB,
      "UPDATE message_opens SET created_at=?",
      Date.now() - 91 * 86400000,
    );
    await trackingWorker.fetch(new Request(row.image_url), {
      ...env,
      APP_ORIGIN: origin,
    });
    expect(
      (await one<{ first_opened_at: number | null }>(
        env.DB,
        "SELECT first_opened_at FROM message_opens",
      ))!.first_opened_at,
    ).toBeNull();
  });
});
describe("receiving and status safety", () => {
  it("deduplicates messages and reopens customer responses", async () => {
    const c = await incoming();
    await run(
      env.DB,
      "UPDATE conversations SET status='closed' WHERE id=?",
      c.id,
    );
    await incoming("second");
    await incoming("second");
    expect((await all(env.DB, "SELECT * FROM messages")).length).toBe(2);
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("open");
  });
  it("excludes Spam, Trash, Drafts and all pre-cutover messages", async () => {
    for (const label of ["SPAM", "TRASH", "DRAFT"])
      await ingestMessage(
        env,
        await getMailbox(env, "mailbox"),
        "token",
        message(label, { labelIds: [label] }),
        [inbox],
      );
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("old", { internalDate: "999" }),
      [inbox],
    );
    expect(await all(env.DB, "SELECT * FROM conversations")).toHaveLength(0);
  });
  it("records missing history when a customer replies to an old conversation", async () => {
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("new", {}, [
        { name: "In-Reply-To", value: "<old@example.test>" },
      ]),
      [inbox],
    );
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))
        ?.history_missing,
    ).toBe(1);
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(1);
  });
  it("imports attachments and inline content once", async () => {
    const gm = message("file");
    gm.payload = {
      ...gm.payload,
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("body").toString("base64url") },
        },
        {
          mimeType: "image/png",
          filename: "test.png",
          headers: [{ name: "Content-ID", value: "<photo>" }],
          body: { data: "eA", size: 1 },
        },
      ],
    };
    await ingestMessage(env, await getMailbox(env, "mailbox"), "token", gm, [
      inbox,
    ]);
    await ingestMessage(env, await getMailbox(env, "mailbox"), "token", gm, [
      inbox,
    ]);
    expect(await all(env.DB, "SELECT * FROM attachments")).toHaveLength(1);
  });
  it("retains a visible notice for an oversized attachment without blocking later mail", async () => {
    const gm = message("large");
    gm.payload = {
      ...gm.payload,
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "application/zip",
          filename: "huge.zip",
          body: { size: 30 * 1024 * 1024, attachmentId: "huge" },
        },
      ],
    };
    const decoded = await decodeMessage("token", gm);
    expect(decoded.text).toContain("24 MB");
    expect(decoded.attachments).toHaveLength(0);
  });
  it("reconciles sends made directly in Gmail", async () => {
    const c = await incoming();
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("direct", { labelIds: ["SENT"] }, [
        { name: "From", value: "support@example.com" },
        { name: "To", value: contact.email },
      ]),
      [inbox],
    );
    expect(
      (
        await one<Conversation>(
          env.DB,
          "SELECT * FROM conversations WHERE id=?",
          c.id,
        )
      )?.status,
    ).toBe("closed");
  });
  it("reopens a ticket when a bounce references its outgoing message", async () => {
    const c = await incoming();
    const job = await enqueueOutgoing(env, payload(c));
    await markSent(env, job, "sent", "thread");
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("bounce", { threadId: "bounce-thread" }, [
        { name: "From", value: "mailer-daemon@example.test" },
        { name: "Original-Message-ID", value: job.message_id },
        { name: "Content-Type", value: "multipart/report" },
      ]),
      [inbox],
    );
    expect(
      (
        await one<Conversation>(
          env.DB,
          "SELECT * FROM conversations WHERE id=?",
          c.id,
        )
      )?.status,
    ).toBe("open");
    expect(
      await all(env.DB, "SELECT * FROM events WHERE kind='delivery_failure'"),
    ).toHaveLength(1);
  });
  it("processes every history page and recovers an expired cursor", async () => {
    let expired = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("oauth2.googleapis.com"))
        return json({ access_token: "token" });
      if (u.includes("/history?")) {
        if (expired) return json({}, 404);
        return u.includes("pageToken")
          ? json({
              historyId: "300",
              history: [{ messagesAdded: [{ message: { id: "second" } }] }],
            })
          : json({
              historyId: "300",
              nextPageToken: "next",
              history: [{ messagesAdded: [{ message: { id: "first" } }] }],
            });
      }
      if (u.endsWith("/profile")) return json({ historyId: "400" });
      if (u.includes("/messages?q="))
        return json({ messages: [{ id: "third" }] });
      return json(
        message(
          u.includes("first")
            ? "first"
            : u.includes("second")
              ? "second"
              : "third",
        ),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    await synchronize(env, "mailbox");
    expect((await getMailbox(env, "mailbox")).history_id).toBe("300");
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(2);
    expired = true;
    await synchronize(env, "mailbox");
    expect((await getMailbox(env, "mailbox")).history_id).toBe("400");
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(3);
  });
  it("shows revoked authorization as a connection error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "invalid_grant" }, 400)),
    );
    await synchronize(env, "mailbox");
    expect((await getMailbox(env, "mailbox")).state).toBe("disconnected");
  });
});
describe("durable sending", () => {
  it("uses one persisted job for double-clicks and duplicates", async () => {
    const c = await incoming();
    const [a, b] = await Promise.all([
      enqueueOutgoing(env, payload(c)),
      enqueueOutgoing(env, payload(c)),
    ]);
    expect(a.id).toBe(b.id);
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(1);
    let sends = 0;
    await mockGoogle(() => {
      sends++;
      return json({ id: "sent", threadId: "thread" });
    });
    await Promise.all([sendOutgoing(env, a.id), sendOutgoing(env, a.id)]);
    expect(sends).toBe(1);
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("closed");
  });
  it("keeps incoming mail actionable when it arrives during a send", async () => {
    const c = await incoming();
    const job = await enqueueOutgoing(env, payload(c));
    await mockGoogle(async () => {
      await incoming("concurrent");
      return json({ id: "sent", threadId: "thread" });
    });
    await sendOutgoing(env, job.id);
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("open");
  });
  it("does not close on failed or uncertain sends", async () => {
    const c = await incoming();
    const job = await enqueueOutgoing(env, payload(c));
    await mockGoogle(() => {
      throw new TypeError("network interruption");
    });
    await sendOutgoing(env, job.id);
    expect((await one<Outgoing>(env.DB, "SELECT * FROM outgoing"))?.state).toBe(
      "uncertain",
    );
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("open");
  });
  it("does not resend an uncertain send before reconciling Gmail", async () => {
    const c = await incoming();
    const job = await enqueueOutgoing(env, payload(c));
    await run(
      env.DB,
      "UPDATE outgoing SET state='uncertain' WHERE id=?",
      job.id,
    );
    let sends = 0;
    await mockGoogle(() => {
      sends++;
      return json({ id: "sent", threadId: "thread" });
    });
    await sendOutgoing(env, job.id);
    expect(sends).toBe(0);
    expect((await one<Outgoing>(env.DB, "SELECT * FROM outgoing"))?.state).toBe(
      "uncertain",
    );
  });
  it("preserves Send and Waiting through a later Gmail echo", async () => {
    const c = await incoming();
    const job = await enqueueOutgoing(env, {
      ...payload(c),
      status: "waiting",
    });
    await markSent(env, job, "sent", "thread");
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("sent", { labelIds: ["SENT"] }, [
        { name: "Message-ID", value: job.message_id },
        { name: "From", value: inbox.address },
        { name: "To", value: contact.email },
      ]),
      [inbox],
    );
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("waiting");
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(2);
  });
  it("does not create a second ticket if Sent sync wins the send response race", async () => {
    const job = await enqueueOutgoing(env, {
      ...payload({ id: "", subject: "New" } as Conversation),
      conversation_id: undefined,
      kind: "new",
    });
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("sent", { labelIds: ["SENT"], threadId: "brand-new" }, [
        { name: "Message-ID", value: job.message_id },
        { name: "From", value: inbox.address },
        { name: "To", value: contact.email },
      ]),
      [inbox],
    );
    await markSent(env, job, "sent", "brand-new");
    expect(await all(env.DB, "SELECT * FROM conversations")).toHaveLength(1);
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(1);
  });
  it("applies inbox signatures and Auto BCC at enqueue time", async () => {
    const c = await incoming();
    await run(
      env.DB,
      "UPDATE inboxes SET signature='Thanks, {{inbox.name}}',auto_bcc='archive@example.test' WHERE id=?",
      inbox.id,
    );
    const job = await enqueueOutgoing(env, payload(c));
    expect(JSON.parse(job.payload).text).toContain("Thanks, Northstar Support");
    expect(JSON.parse(job.payload).bcc).toContain("archive@example.test");
  });
  it("blocks sends after restore until reconciliation", async () => {
    const c = await incoming();
    await setSetting(env, "restore_reconciled", "false");
    await expect(enqueueOutgoing(env, payload(c))).rejects.toThrow("paused");
  });
  it("produces MIME with CC, BCC, stable ID, reply headers and encoded attachment", () => {
    const p = payload({ id: "c", subject: "Test" } as Conversation);
    p.cc = ["cc@example.test"];
    p.bcc = ["bcc@example.test"];
    const mime = Buffer.from(
      buildMime(
        p,
        "Northstar",
        inbox.address,
        "<stable@example.com>",
        { id: "<parent@example.test>" },
        [
          {
            filename: "résumé.txt",
            contentType: "text/plain",
            data: Buffer.from("file"),
          },
        ],
      ),
      "base64url",
    ).toString();
    expect(mime).toContain("Cc: cc@example.test");
    expect(mime).toContain("Bcc: bcc@example.test");
    expect(mime).toContain("In-Reply-To: <parent@example.test>");
    expect(mime).toContain("Message-ID: <stable@example.com>");
    expect(mime).toContain("ZmlsZQ==");
  });
});
describe("contact-form customer identity", () => {
  const relay = (id: string, replyTo: string) =>
    message(id, { threadId: `thread-${id}` }, [
      { name: "From", value: "Freemius Support <support@freemius.com>" },
      { name: "Reply-To", value: replyTo },
    ]);
  const ingest = async (mail: GmailMessage) =>
    ingestMessage(env, await getMailbox(env, "mailbox"), "token", mail, [
      inbox,
    ]);

  it("uses the customer's existing identity and history for a relay acknowledgement", async () => {
    const original = await incoming();
    await setSetting(env, "acknowledgements_enabled", "true");
    const mail = relay("form", "Test Customer <customer@example.test>");
    await ingest(mail);
    await ingest(mail);
    const conversation = (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE gmail_thread_id='thread-form'",
    ))!;
    expect(conversation.contact_id).toBe(contact.id);
    const response = await request(`/api/conversations/${conversation.id}`);
    const detail = (await response.json()) as {
      contact: Contact;
      history: Conversation[];
    };
    expect(detail.contact.email).toBe(contact.email);
    expect(detail.history.some((c) => c.id === original.id)).toBe(true);
    const sender = await one<{ sender: string; sender_name: string }>(
      env.DB,
      "SELECT sender,sender_name FROM messages WHERE gmail_id='form'",
    );
    expect(sender).toEqual({
      sender: "support@freemius.com",
      sender_name: "Freemius Support",
    });
    const jobs = await all<Outgoing>(env.DB, "SELECT * FROM outgoing");
    expect(jobs).toHaveLength(1);
    const ack = JSON.parse(jobs[0].payload) as ComposePayload;
    expect(ack.to).toEqual([contact.email]);
    expect(ack.text).toMatch(/^Hello Test,/);
    await markSent(env, jobs[0], "auto-sent", "thread-form");
    expect(
      (
        await one<Conversation>(
          env.DB,
          "SELECT * FROM conversations WHERE id=?",
          conversation.id,
        )
      )?.status,
    ).toBe("open");
  });

  it("keeps different form submitters separate instead of combining them under Freemius", async () => {
    await setSetting(env, "acknowledgements_enabled", "true");
    for (const [id, name, email] of [
      ["alex", "Alex Morgan", "alex@example.test"],
      ["elena", "Elena Martin", "elena@example.test"],
    ]) {
      await ingest(relay(id, `${name} <${email}>`));
      const c = (await one<Conversation>(
        env.DB,
        "SELECT * FROM conversations WHERE gmail_thread_id=?",
        `thread-${id}`,
      ))!;
      const person = (await one<Contact>(
        env.DB,
        "SELECT * FROM contacts WHERE id=?",
        c.contact_id,
      ))!;
      expect(person.email).toBe(email);
      expect(person.name).toBe(name);
      const job = (await one<Outgoing>(
        env.DB,
        "SELECT * FROM outgoing WHERE conversation_id=?",
        c.id,
      ))!;
      expect(JSON.parse(job.payload).text).toMatch(
        new RegExp(`^Hello ${name.split(" ")[0]},`),
      );
    }
    expect(
      await one(
        env.DB,
        "SELECT * FROM contacts WHERE email='support@freemius.com'",
      ),
    ).toBeNull();
  });

  it("uses a neutral greeting when the form supplies an email without a name", async () => {
    await setSetting(env, "acknowledgements_enabled", "true");
    await ingest(relay("nameless", "unknown@example.test"));
    const job = (await one<Outgoing>(env.DB, "SELECT * FROM outgoing"))!;
    expect(JSON.parse(job.payload).to).toEqual(["unknown@example.test"]);
    expect(JSON.parse(job.payload).text).toMatch(/^Hello there,/);
  });

  it("reuses a known customer name when Reply-To contains only their email", async () => {
    await setSetting(env, "acknowledgements_enabled", "true");
    await ingest(relay("known", contact.email));
    const job = (await one<Outgoing>(env.DB, "SELECT * FROM outgoing"))!;
    expect(JSON.parse(job.payload).text).toMatch(/^Hello Test,/);
    expect(
      (
        await one<Contact>(
          env.DB,
          "SELECT * FROM contacts WHERE id=?",
          contact.id,
        )
      )?.name,
    ).toBe(contact.name);
  });

  it("preserves direct sender names and does not select an arbitrary person from multiple reply targets", async () => {
    const direct = await decodeMessage(
      "token",
      message("direct", {}, [{ name: "Reply-To", value: contact.email }]),
    );
    expect(customerIdentity(direct, [inbox.address])).toEqual({
      email: contact.email,
      name: contact.name,
    });
    const ambiguous = await decodeMessage(
      "token",
      relay("multiple", "One <one@example.test>, Two <two@example.test>"),
    );
    expect(customerIdentity(ambiguous, [inbox.address])).toEqual({
      email: "support@freemius.com",
      name: "Freemius Support",
    });
    const sent = await decodeMessage(
      "token",
      message("sent", { labelIds: ["SENT"] }, [
        { name: "From", value: inbox.address },
        { name: "Reply-To", value: "irrelevant@example.test" },
        { name: "To", value: "Elena Martin <elena@example.test>" },
      ]),
    );
    expect(customerIdentity(sent, [inbox.address], true)).toEqual({
      email: "elena@example.test",
      name: "Elena Martin",
    });
  });

  it("suppresses acknowledgements when a relay's Reply-To points back to a support address", async () => {
    await setSetting(env, "acknowledgements_enabled", "true");
    await ingest(relay("support-loop", inbox.address));
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(0);
  });
});

describe("acknowledgements and provider truthfulness", () => {
  it("uses template fallbacks and configured office hours", () => {
    expect(template("Hello {{customer.firstName|there}}!", {})).toBe(
      "Hello there!",
    );
    expect(outsideOfficeHours(new Date("2026-09-14T09:00:00Z"), inbox)).toBe(
      false,
    );
    expect(outsideOfficeHours(new Date("2026-09-14T17:00:00Z"), inbox)).toBe(
      true,
    );
    expect(outsideOfficeHours(new Date("2026-09-12T09:00:00Z"), inbox)).toBe(
      true,
    );
  });
  it("suppresses bounces, mailing lists, robots and support-address loops", async () => {
    for (const headers of [
      [{ name: "Auto-Submitted", value: "auto-replied" }],
      [{ name: "List-ID", value: "newsletter" }],
      [{ name: "Precedence", value: "bulk" }],
      [{ name: "From", value: "support@example.com" }],
      [{ name: "From", value: "mailer-daemon@example.test" }],
    ])
      expect(
        shouldAcknowledge(
          await decodeMessage("t", message("m", {}, headers)),
          inbox,
          [inbox.address],
          new Date(),
        ),
      ).toBe(false);
  });
  it("queues one acknowledgement per new conversation and never closes it", async () => {
    await setSetting(env, "acknowledgements_enabled", "true");
    await incoming();
    await incoming();
    const jobs = await all<Outgoing>(env.DB, "SELECT * FROM outgoing");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("auto");
    await markSent(env, jobs[0], "auto-sent", "thread");
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("open");
  });
  it("distinguishes active, lifetime, expired, trial and free entitlements", () => {
    expect(entitlement([])).toBe("Free");
    expect(entitlement([{ expiration: null }])).toBe("Active paid");
    expect(entitlement([{ expiration: "2030-01-01T00:00:00Z" }])).toBe(
      "Active paid",
    );
    expect(entitlement([{ expiration: "2000-01-01 00:00:00" }])).toBe(
      "Expired / inactive",
    );
    expect(entitlement([{ expiration: null, is_trial: true }])).toBe("Trial");
  });
  it("limits callback URLs to the expected provider and product", () => {
    expect(() => validateFreemiusCallback("https://evil.test/")).toThrow();
    expect(() =>
      validateFreemiusCallback(
        "https://api.freemius.com/v1/developers/54321/plugins/12345/customer-lookup.json?redirect=evil",
      ),
    ).toThrow();
  });
  it("shows callback not-found separately from outages and caches for five minutes", async () => {
    await setSetting(env, "freemius_mode", "callback");
    await setSetting(
      env,
      "freemius_callback_url",
      "https://api.freemius.com/v1/developers/54321/plugins/12345/customer-lookup.json",
    );
    await saveSecret(env, "freemius_callback_secret", "test-secret");
    await setSetting(env, "freemius_signature_header", "X-Customer-Signature");
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _options?: RequestInit) =>
        json({ html: "<p>User doesn't exist.</p>" }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await customerIntegration(env, contact, "freemius")).state).toBe(
      "not_found",
    );
    await customerIntegration(env, contact, "freemius");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sentOptions = fetcher.mock.calls[0][1]!;
    const sentHeaders = new Headers(sentOptions.headers);
    expect(sentHeaders.get("X-Customer-Signature")).toMatch(
      /^[A-Za-z0-9+/]+=*$/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({}, 401)),
    );
    expect(
      (await customerIntegration(env, contact, "freemius", true)).state,
    ).toBe("error");
  });
  it("validates the configured signing header and requires it for callback requests", async () => {
    expect(validateSignatureHeader("X-Customer-Signature")).toBe(
      "X-Customer-Signature",
    );
    for (const header of [
      "Authorization",
      "X-Signature\r\nInjected: value",
      "",
      "X-",
      "X-" + "a".repeat(61),
    ])
      expect(() => validateSignatureHeader(header)).toThrow();
    expect(
      (
        await request("/api/settings", "PUT", {
          freemius_signature_header: "Authorization",
        })
      ).status,
    ).toBe(400);
    await setSetting(
      env,
      "freemius_callback_url",
      "https://api.freemius.com/v1/developers/999/products/12345/customer-lookup.json",
    );
    await saveSecret(env, "freemius_callback_secret", "test-secret");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await customerIntegration(env, contact, "freemius", true)).state,
    ).toBe("unconfigured");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("ignores fuzzy Mailchimp matches and lists audiences without subscription actions", async () => {
    await saveSecret(env, "mailchimp_key", "test-key-us1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("search-members")
          ? json({
              exact_matches: { members: [] },
              full_search: {
                members: [
                  {
                    id: "other",
                    list_id: "list",
                    email_address: "different@example.test",
                  },
                ],
              },
            })
          : json({
              lists: [{ id: "list", name: "Northstar" }],
              total_items: 1,
            }),
      ),
    );
    const result = await customerIntegration(env, contact, "mailchimp");
    expect(result.state).toBe("not_found");
    expect(result.data?.audiences).toEqual([{ id: "list", name: "Northstar" }]);
  });
  it("exports a relational snapshot and attachment manifest", async () => {
    await incoming();
    await run(env.DB, "UPDATE conversations SET deleted_at=12345,revision=7");
    const largeSnapshot = JSON.stringify({
      text: "Customer's record 🙂 — details. ".repeat(12000),
    });
    await run(
      env.DB,
      "INSERT INTO integration_snapshots VALUES (?,?,?,?)",
      contact.id,
      "freemius",
      largeSnapshot,
      Date.now(),
    );
    await backup(env);
    const last = JSON.parse(
      (await one<{ value: string }>(
        env.DB,
        "SELECT value FROM settings WHERE key='last_backup'",
      ))!.value,
    );
    const manifest = await (await env.BACKUPS.get(last.key))!.json<{
      tables: { table: string; key: string; rows: number }[];
    }>();
    expect(manifest.tables).toHaveLength(BACKUP_TABLES.length);
    expect(manifest.tables.find((x) => x.table === "messages")?.rows).toBe(1);
    const snapshot: Record<string, Record<string, unknown>[]> = {};
    for (const t of manifest.tables)
      snapshot[t.table] = await (await env.BACKUPS.get(t.key))!.json();
    const statements = recoveryStatements(snapshot);
    expect(statements.every((sql) => Buffer.byteLength(sql) < 80000)).toBe(
      true,
    );
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(1);
    expect(
      await one(env.DB, "SELECT deleted_at,revision FROM conversations"),
    ).toEqual({ deleted_at: 12345, revision: 7 });
    expect(await one(env.DB, "SELECT gmail_thread_id FROM messages")).toEqual({
      gmail_thread_id: "thread",
    });
    expect(
      (
        await one<{ payload: string }>(
          env.DB,
          "SELECT payload FROM integration_snapshots",
        )
      )?.payload,
    ).toBe(largeSnapshot);
    expect(
      (
        await one<{ value: string }>(
          env.DB,
          "SELECT value FROM settings WHERE key='restore_reconciled'",
        )
      )?.value,
    ).toBe("false");
  });
});

it("retains inline attachments in the original and forwarded message", async () => {
  const gm = message("inline");
  gm.payload = {
    ...gm.payload,
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "text/html",
        body: {
          data: Buffer.from('<p>Screenshot</p><img src="cid:photo">').toString(
            "base64url",
          ),
        },
      },
      {
        mimeType: "image/png",
        filename: "photo.png",
        headers: [{ name: "Content-ID", value: "<photo>" }],
        body: { data: "eA", size: 1 },
      },
    ],
  };
  await ingestMessage(env, await getMailbox(env, "mailbox"), "token", gm, [
    inbox,
  ]);
  const c = (await one<Conversation>(env.DB, "SELECT * FROM conversations"))!;
  const a = (await one<{ id: string }>(env.DB, "SELECT id FROM attachments"))!;
  const job = await enqueueOutgoing(env, {
    ...payload(c),
    kind: "forward",
    html: `<p>Forward</p><img src="/api/attachments/${a.id}/inline">`,
    attachment_ids: [a.id],
  });
  expect(JSON.parse(job.payload).html).toContain("cid:photo");
  await markSent(env, job, "forwarded", "forwarded-thread");
  const response = await request(`/api/conversations/${c.id}`);
  expect(response.status).toBe(200);
  const detail = (await response.json()) as {
    messages: { attachments: unknown[] }[];
  };
  expect(detail.messages.map((m) => m.attachments.length)).toEqual([1, 1]);
});
it("does not label malformed provider responses as unmatched customers", async () => {
  await setSetting(env, "freemius_mode", "api");
  await saveSecret(env, "freemius_token", "test-token");
  await saveSecret(env, "mailchimp_key", "key-us1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({})),
  );
  expect((await customerIntegration(env, contact, "freemius")).state).toBe(
    "error",
  );
  expect((await customerIntegration(env, contact, "mailchimp")).state).toBe(
    "error",
  );
});
it("keeps the previous completed backup if replacement export fails", async () => {
  await incoming();
  await backup(env);
  const previous = (await one<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key='last_backup'",
  ))!.value;
  const failing = {
    ...env,
    BACKUPS: {
      put: async () => {
        throw Error("unavailable");
      },
    },
  } as unknown as AppEnv;
  await expect(backup(failing)).rejects.toThrow();
  expect(
    (await one<{ value: string }>(
      env.DB,
      "SELECT value FROM settings WHERE key='last_backup'",
    ))!.value,
  ).toBe(previous);
  expect(
    (await one<{ value: string }>(
      env.DB,
      "SELECT value FROM settings WHERE key='backup_error'",
    ))!.value,
  ).toContain("failed");
});

it("accepts Gmail's primary address without verificationStatus and rejects unverified aliases", async () => {
  const mailbox = await getMailbox(env, "mailbox");
  mailbox.aliases = JSON.stringify([
    { sendAsEmail: mailbox.email, isPrimary: true },
    { sendAsEmail: "verified@example.com", verificationStatus: "accepted" },
    { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
    { sendAsEmail: "unknown@example.com" },
  ]);
  expect(verifiedSendingAddress(mailbox, "SUPPORT@example.com")).toBe(true);
  expect(verifiedSendingAddress(mailbox, "verified@example.com")).toBe(true);
  expect(verifiedSendingAddress(mailbox, "pending@example.com")).toBe(false);
  expect(verifiedSendingAddress(mailbox, "unknown@example.com")).toBe(false);
  expect(verifiedSendingAddress(mailbox, "elsewhere@example.test")).toBe(false);
});

it("uses a redirect policy supported by Workers and never follows credential-bearing provider redirects", async () => {
  await saveSecret(env, "mailchimp_key", "test-key-us1");
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, options?: RequestInit) => {
      const runtime = await mf.dispatchFetch(
        "http://localhost/request-policy",
        {
          method: "POST",
          body: JSON.stringify({ redirect: options?.redirect }),
        },
      );
      expect(runtime.status).toBe(200);
      expect(await runtime.json()).toEqual({ redirect: "manual" });
      return new Response(null, {
        status: 302,
        headers: { Location: "https://unexpected.example.test/" },
      });
    },
  );
  vi.stubGlobal("fetch", fetcher);
  const result = await customerIntegration(env, contact, "mailchimp");
  expect(result.state).toBe("error");
  expect(result.error).toContain("302");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

describe("branded subjects and Gmail thread links", () => {
  it("keeps plan dynamic and strips only recognized Freemius envelope categories", () => {
    for (const category of [
      "Technical Support",
      "Billing Issue",
      "Feature Request",
      "Customization",
      "Pre-Sale Question",
      "Press",
      "Bug",
    ]) {
      expect(
        supportSubject(
          `[Plugin: northstar-plugin] [Plan: pro] [ ${category}] This is another test`,
          brand,
        ),
      ).toBe("[Northstar · Pro] — This is another test");
    }
    expect(
      supportSubject(
        "Re: [Plugin: northstar-plugin] [Plan: free] [Bug] [Important] Keep this",
        brand,
      ),
    ).toBe("Re: [Northstar · Free] — [Important] Keep this");
    expect(
      supportSubject(
        "[Plugin: northstar-plugin] [Plan: business] [Important] Keep this",
        brand,
      ),
    ).toBe("[Northstar · Business] — [Important] Keep this");
    for (const subject of [
      "Billing issue",
      "[Plugin: another-plugin] [Plan: pro] [Bug] Example",
      "[Northstar · Pro] — Original text",
    ])
      expect(supportSubject(subject)).toBe(subject);
    expect(
      sameEmailSubject(
        "Re: [Northstar · Pro] — Test",
        "[Northstar · Pro] — Test",
      ),
    ).toBe(true);
    expect(sameEmailSubject("Old subject", "New subject")).toBe(false);
  });
  it("starts a matching branded Gmail thread and keeps old and new customer replies on one ticket", async () => {
    const original =
      "[Plugin: northstar-plugin] [Plan: pro] [ Technical Support] Another test";
    const form = message("form");
    form.payload.headers!.find((h) => h.name === "Subject")!.value = original;
    await ingestMessage(env, await getMailbox(env, "mailbox"), "token", form, [
      inbox,
    ]);
    const c = (await one<Conversation>(env.DB, "SELECT * FROM conversations"))!;
    expect(c.subject).toBe("[Northstar · Pro] — Another test");
    expect(
      (await one<{ subject: string }>(env.DB, "SELECT subject FROM messages"))
        ?.subject,
    ).toBe(original);
    const sentRequests: { raw: string; threadId?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com"))
          return json({ access_token: "token" });
        if (url.includes("messages?q=")) return json({ messages: [] });
        if (url.includes("messages/send")) {
          sentRequests.push(JSON.parse(String(options?.body)));
          return json({
            id: `sent-${sentRequests.length}`,
            threadId: "branded-thread",
          });
        }
        throw Error("Unexpected request");
      }),
    );
    const first = await enqueueOutgoing(env, {
      ...payload(c),
      subject: original,
    });
    await sendOutgoing(env, first.id);
    expect(sentRequests[0].threadId).toBeUndefined();
    const sentMail = await (
      await import("postal-mime")
    ).default.parse(Buffer.from(sentRequests[0].raw, "base64url"));
    expect(sentMail.subject).toBe(c.subject);
    expect(sentMail.inReplyTo).toBe("<form@example.test>");
    expect(await all(env.DB, "SELECT * FROM thread_links")).toHaveLength(2);
    const second = await enqueueOutgoing(
      env,
      payload(c, "second-branded-reply"),
    );
    await sendOutgoing(env, second.id);
    expect(sentRequests[1].threadId).toBe("branded-thread");
    for (const threadId of ["thread", "branded-thread"]) {
      const reply = message(`reply-${threadId}`, { threadId });
      reply.payload.headers!.find((h) => h.name === "Subject")!.value =
        `Re: ${threadId === "thread" ? original : c.subject}`;
      await ingestMessage(
        env,
        await getMailbox(env, "mailbox"),
        "token",
        reply,
        [inbox],
      );
    }
    expect(await all(env.DB, "SELECT * FROM conversations")).toHaveLength(1);
    expect(
      (await one<Conversation>(env.DB, "SELECT * FROM conversations"))?.status,
    ).toBe("open");
    expect(
      await all(
        env.DB,
        "SELECT * FROM messages WHERE gmail_thread_id='branded-thread'",
      ),
    ).toHaveLength(3);
  });
});

describe("global unread count", () => {
  const count = async (query = "") => {
    const response = await request(`/api/conversations/unread-count${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.json() as Promise<{ unread_count: number }>;
  };
  it("counts unread conversations across inboxes and statuses beyond a list page, excluding Trash", async () => {
    await incoming();
    await incoming("another-message-in-same-thread");
    await run(
      env.DB,
      "INSERT INTO inboxes(id,name,address,from_name,created_at) VALUES ('second','Second','second@example.test','Second',1)",
    );
    await env.DB.batch(
      Array.from({ length: 60 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO conversations(id,number,inbox_id,contact_id,subject,status,unread,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1)",
        ).bind(
          `count-${i}`,
          100 + i,
          i % 2 ? "inbox" : "second",
          contact.id,
          `Fixture ${i}`,
          ["open", "waiting", "closed"][i % 3],
          i < 55 ? 1 : 0,
          i === 54 ? 1 : null,
        ),
      ),
    );
    expect(await count()).toEqual({ unread_count: 55 });
    expect(
      await count("?inbox=inbox&status=closed&q=not-a-match&offset=50"),
    ).toEqual({ unread_count: 55 });
  });
  it("tracks read, unread, Trash, restore and a new reply without counting acknowledgements", async () => {
    expect(await count()).toEqual({ unread_count: 0 });
    await setSetting(env, "acknowledgements_enabled", "true");
    const c = await incoming();
    const ack = (await one<Outgoing>(
      env.DB,
      "SELECT * FROM outgoing WHERE kind='auto'",
    ))!;
    await markSent(env, ack, "auto-sent", "thread");
    expect(await count()).toEqual({ unread_count: 1 });
    expect(
      (await request(`/api/conversations/${c.id}`, "PATCH", { unread: false }))
        .status,
    ).toBe(200);
    expect(await count()).toEqual({ unread_count: 0 });
    for (const [action, expected] of [
      ["unread", 1],
      ["trash", 0],
      ["restore", 1],
      ["read", 0],
    ] as const) {
      const current = (await one<Conversation>(
        env.DB,
        "SELECT * FROM conversations WHERE id=?",
        c.id,
      ))!;
      expect(
        (
          await request("/api/conversations/bulk", "POST", {
            action,
            items: [{ id: c.id, revision: current.revision }],
          })
        ).status,
      ).toBe(200);
      expect(await count()).toEqual({ unread_count: expected });
    }
    await incoming("new-reply");
    expect(await count()).toEqual({ unread_count: 1 });
  });
});

describe("bulk selection and recoverable Trash", () => {
  async function act(action: string, items: Conversation[]) {
    const response = await request("/api/conversations/bulk", "POST", {
      action,
      items: items.map(({ id, revision }) => ({ id, revision })),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      updated: string[];
      skipped: { id: string }[];
    }>;
  }
  async function current(id: string) {
    return (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE id=?",
      id,
    ))!;
  }
  it("changes selected statuses and read flags, and skips stale revisions including new customer replies", async () => {
    const c = await incoming();
    expect((await act("waiting", [c])).updated).toEqual([c.id]);
    expect((await act("closed", [c])).skipped).toHaveLength(1);
    const selected = await current(c.id);
    await incoming("new-customer-reply");
    expect((await act("trash", [selected])).skipped).toHaveLength(1);
    expect((await current(c.id)).status).toBe("open");
    expect((await act("read", [await current(c.id)])).updated).toEqual([c.id]);
    expect((await current(c.id)).unread).toBe(0);
    expect((await act("unread", [await current(c.id)])).updated).toEqual([
      c.id,
    ]);
    expect((await current(c.id)).unread).toBe(1);
  });
  it("moves tickets out of normal lists into Trash, retains messages, blocks sending and restores status", async () => {
    const c = await incoming();
    await act("waiting", [c]);
    expect((await act("trash", [await current(c.id)])).updated).toEqual([c.id]);
    const regular = (await (await request("/api/conversations")).json()) as {
      items: unknown[];
    };
    expect(regular.items).toHaveLength(0);
    const counts = (await (
      await request("/api/conversations/counts")
    ).json()) as Record<string, number>;
    expect(counts.trash).toBe(1);
    expect(counts.waiting).toBeUndefined();
    expect(
      await (await request("/api/conversations/counts?inbox=missing")).json(),
    ).toEqual({});
    const trash = (await (
      await request("/api/conversations?status=trash")
    ).json()) as { items: unknown[] };
    expect(trash.items).toHaveLength(1);
    expect(await all(env.DB, "SELECT * FROM messages")).toHaveLength(1);
    await expect(enqueueOutgoing(env, payload(c))).rejects.toThrow("Restore");
    expect((await act("restore", [await current(c.id)])).updated).toEqual([
      c.id,
    ]);
    expect((await current(c.id)).deleted_at).toBeNull();
    expect((await current(c.id)).status).toBe("waiting");
  });
  it("does not hide queued or uncertain sends and refuses retries from Trash", async () => {
    await mockGoogle();
    const c = await incoming();
    const job = await enqueueOutgoing(env, payload(c));
    expect((await act("trash", [c])).skipped).toHaveLength(1);
    await run(
      env.DB,
      "UPDATE outgoing SET state='uncertain' WHERE id=?",
      job.id,
    );
    expect((await act("trash", [c])).skipped).toHaveLength(1);
    await run(env.DB, "UPDATE outgoing SET state='failed' WHERE id=?", job.id);
    expect((await act("trash", [c])).updated).toEqual([c.id]);
    expect(
      (await request(`/api/outgoing/${job.id}/retry`, "POST", {})).status,
    ).toBe(409);
    expect((await one<Outgoing>(env.DB, "SELECT * FROM outgoing"))?.state).toBe(
      "failed",
    );
  });
  it("keeps duplicates and old cursor recovery in Trash but restores genuinely new replies", async () => {
    const c = await incoming();
    await act("trash", [c]);
    await incoming();
    expect((await current(c.id)).deleted_at).not.toBeNull();
    const older = message("older", {
      internalDate: String(Date.now() - 60000),
    });
    await ingestMessage(env, await getMailbox(env, "mailbox"), "token", older, [
      inbox,
    ]);
    expect((await current(c.id)).deleted_at).not.toBeNull();
    const newer = message("newer", { internalDate: String(Date.now() + 1000) });
    await ingestMessage(env, await getMailbox(env, "mailbox"), "token", newer, [
      inbox,
    ]);
    expect((await current(c.id)).deleted_at).toBeNull();
    expect((await current(c.id)).status).toBe("open");
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(0);
  });
  it("returns partial success and rejects oversized, duplicate, or invalid selections", async () => {
    const c = await incoming();
    const second = message("second", { threadId: "other-thread" });
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      second,
      [inbox],
    );
    const other = (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE id<>?",
      c.id,
    ))!;
    const result = await act("closed", [c, { ...other, revision: 999 }]);
    expect(result.updated).toEqual([c.id]);
    expect(result.skipped.map((r) => r.id)).toEqual([other.id]);
    for (const body of [
      { action: "trash", items: [] },
      {
        action: "trash",
        items: [
          { id: c.id, revision: 1 },
          { id: c.id, revision: 1 },
        ],
      },
      {
        action: "trash",
        items: Array.from({ length: 51 }, (_, i) => ({
          id: String(i),
          revision: 0,
        })),
      },
      { action: "purge", items: [{ id: c.id, revision: 1 }] },
    ])
      expect(
        (await request("/api/conversations/bulk", "POST", body)).status,
      ).toBe(400);
    expect(
      (
        await request(
          "/api/conversations/bulk",
          "POST",
          { action: "trash", items: [{ id: c.id, revision: 1 }] },
          { Origin: "https://untrusted.test" },
        )
      ).status,
    ).toBe(403);
  });
});

describe("AI draft safety", () => {
  async function ready() {
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("ai-message", { internalDate: String(Date.now()) }),
      [inbox],
    );
    const c = (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations LIMIT 1",
    ))!;
    await setSetting(
      env,
      "ai_config",
      JSON.stringify({
        ...DEFAULT_AI,
        enabled: true,
        enabled_at: 0,
        revision: "test",
      }),
    );
    const provider = {
      state: "matched",
      fetched_at: Date.now(),
      data: {
        ...structuredFixture,
        user: { ...structuredFixture.user, email: contact.email },
      },
    };
    await run(
      env.DB,
      "INSERT INTO integration_snapshots(contact_id,provider,payload,fetched_at) VALUES (?,'freemius',?,?)",
      c.contact_id,
      JSON.stringify(provider),
      Date.now(),
    );
    return c;
  }
  const output = {
    reply:
      "Hello,\n\nPlease check the chatbot display settings.\n\nLet us know what you find.",
    notes: "Review these steps.",
    sources: [],
    inputTokens: 100,
    outputTokens: 30,
  };
  it("fails closed for free, expired, trial, ambiguous and unavailable licenses", () => {
    expect(
      paidEligibility(
        { state: "matched", fetched_at: 1, html: callbackFixture },
        "elena@example.test",
      ),
    ).toBeNull();
    expect(
      paidEligibility(
        { state: "matched", fetched_at: 1, html: callbackFixture },
        "wrong@example.test",
      ),
    ).toBeTruthy();
    for (const status of ["Expired", "Trial", "Inactive"])
      expect(
        paidEligibility(
          {
            state: "matched",
            fetched_at: 1,
            html: callbackFixture
              .replaceAll("Active (lifetime)", status)
              .replaceAll("Active", status),
          },
          "elena@example.test",
        ),
      ).toBeTruthy();
    expect(
      paidEligibility(
        { state: "matched", fetched_at: 1, data: structuredFixture },
        "jordan.smith@example.test",
      ),
    ).toBeNull();
    expect(
      paidEligibility({ state: "error", fetched_at: 1 }, contact.email),
    ).toContain("unavailable");
    expect(
      paidEligibility(
        {
          state: "matched",
          fetched_at: 1,
          data: { ...structuredFixture, licenses: [] },
        },
        "jordan.smith@example.test",
      ),
    ).toBeTruthy();
  });
  it("saves an AI result as a draft without sending or closing, and deduplicates jobs", async () => {
    const c = await ready();
    const first = await queueDraft(env, c.id, true);
    const duplicate = await queueDraft(env, c.id, true);
    expect(first?.id).toBe(duplicate?.id);
    const prepared = await prepareRun(env, first!.id);
    expect(prepared).toBeTruthy();
    expect(await prepareRun(env, first!.id)).toBeNull();
    await saveGeneratedDraft(env, prepared!, output);
    const d = await one<{ payload: string }>(
      env.DB,
      "SELECT * FROM drafts WHERE conversation_id=?",
      c.id,
    );
    expect(JSON.parse(d!.payload).text).toBe(output.reply);
    expect(JSON.parse(d!.payload).html).toBe(
      "<p>Hello,</p><p>Please check the chatbot display settings.</p><p>Let us know what you find.</p>",
    );
    const edited = {
      ...JSON.parse(d!.payload),
      text: output.reply.replace(
        "display settings.",
        "display settings first.",
      ),
      html: JSON.parse(d!.payload).html.replace(
        "display settings.",
        "display settings first.",
      ),
    };
    expect(
      (
        await request(`/api/drafts/reply:${c.id}`, "PUT", {
          version: 1,
          conversation_id: c.id,
          payload: edited,
        })
      ).status,
    ).toBe(200);
    const reloaded = (await (
      await request(`/api/drafts/reply:${c.id}`)
    ).json()) as { payload: string };
    expect(JSON.parse(reloaded.payload).html).toBe(edited.html);
    expect(JSON.parse(reloaded.payload).text).toBe(edited.text);
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(0);
    expect(
      (
        await one<Conversation>(
          env.DB,
          "SELECT * FROM conversations WHERE id=?",
          c.id,
        )
      )?.status,
    ).toBe("open");
    expect((await request("/api/drafts")).status).toBe(200);
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("ai-after-draft", { internalDate: String(Date.now() + 1000) }),
      [inbox],
    );
    const later = await queueDraft(env, c.id, true);
    expect(await prepareRun(env, later!.id)).toBeNull();
    const savedView = (await (
      await request(`/api/ai/conversations/${c.id}`)
    ).json()) as { draft_available: boolean; run: AIRun };
    expect(savedView.draft_available).toBe(true);
    expect(savedView.run.id).toBe(first!.id);
    expect(savedView.run.notes).toBe(output.notes);
    expect(savedView.run.input_id).toBe(c.last_inbound_id);
    await run(env.DB, "DELETE FROM drafts WHERE conversation_id=?", c.id);
    const loadedView = (await (
      await request(`/api/ai/conversations/${c.id}?run=${first!.id}`)
    ).json()) as { draft_available: boolean; run: AIRun };
    expect(loadedView.draft_available).toBe(false);
    expect(loadedView.run.id).toBe(first!.id);
    const unrelatedView = (await (
      await request(`/api/ai/conversations/unrelated?run=${first!.id}`)
    ).json()) as { run: AIRun | null };
    expect(unrelatedView.run).toBeNull();
  });
  it("never overwrites a human draft, including edits made during inference", async () => {
    const c = await ready();
    const j = await queueDraft(env, c.id, true);
    const prepared = await prepareRun(env, j!.id);
    await request("/api/drafts/reply:" + c.id, "PUT", {
      version: 0,
      conversation_id: c.id,
      payload: { text: "My own reply", html: "<p>My own reply</p>" },
    });
    await saveGeneratedDraft(env, prepared!, output);
    expect(
      JSON.parse(
        (await one<{ payload: string }>(
          env.DB,
          "SELECT payload FROM drafts WHERE conversation_id=?",
          c.id,
        ))!.payload,
      ).text,
    ).toBe("My own reply");
    expect(
      (
        await one<{ state: string }>(
          env.DB,
          "SELECT state FROM ai_runs WHERE id=?",
          j!.id,
        )
      )?.state,
    ).toBe("skipped");
    const next = await queueDraft(env, c.id, true);
    expect(await prepareRun(env, next!.id)).toBeNull();
  });
  it("requires separate AI paragraphs and escapes their HTML without losing line breaks", () => {
    expect(
      replySchema.safeParse({
        reply_paragraphs: ["Hello, this is one block."],
        reviewer_notes: "",
        source_ids: [],
      }).success,
    ).toBe(false);
    const structured = replySchema.parse({
      reply_paragraphs: [
        "Hello,",
        'Use <script>alert("x")</script> & check your settings.\r\nKeep this line.',
        "Please reply if you need help.",
      ],
      reviewer_notes: "Not part of the email.",
      source_ids: [],
    });
    const html = replyToHtml(structured.reply_paragraphs.join("\n\n"));
    expect(html).toBe(
      "<p>Hello,</p><p>Use &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; check your settings.<br>Keep this line.</p><p>Please reply if you need help.</p>",
    );
    expect(cleanHtml(html, {}, true)).toContain("</p><p>");
    expect(html).not.toContain(structured.reviewer_notes);
  });
  it("rejects stale results after a new customer message or disabling AI", async () => {
    const c = await ready();
    let j = await queueDraft(env, c.id, true);
    let prepared = await prepareRun(env, j!.id);
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("ai-newer", { internalDate: String(Date.now() + 1000) }),
      [inbox],
    );
    await saveGeneratedDraft(env, prepared!, output);
    expect(await all(env.DB, "SELECT * FROM drafts")).toHaveLength(0);
    j = await queueDraft(env, c.id, true);
    prepared = await prepareRun(env, j!.id);
    expect(prepared).toBeTruthy();
    await setSetting(env, "ai_paused", "true");
    await saveGeneratedDraft(env, prepared!, output);
    expect(await all(env.DB, "SELECT * FROM drafts")).toHaveLength(0);
  });
  it("suppresses automated senders before provider or model work", async () => {
    const c = await ready();
    await run(
      env.DB,
      "UPDATE messages SET sender='microsoft-noreply@microsoft.com' WHERE id=?",
      c.last_inbound_id,
    );
    const j = await queueDraft(env, c.id, true);
    expect(await prepareRun(env, j!.id)).toBeNull();
    expect(
      (
        await one<{ started_at: number | null }>(
          env.DB,
          "SELECT started_at FROM ai_runs WHERE id=?",
          j!.id,
        )
      )?.started_at,
    ).toBeNull();
    expect(
      automatedReason(
        {
          direction: "inbound",
          sender: "person@example.test",
          headers: JSON.stringify({ "auto-submitted": "auto-replied" }),
        } as never,
        contact,
        [],
      ),
    ).toBeTruthy();
  });
  it("enforces a daily attempt budget and does not automatically retry interrupted inference", async () => {
    const c = await ready();
    await setSetting(
      env,
      "ai_config",
      JSON.stringify({
        ...DEFAULT_AI,
        enabled: true,
        revision: "test",
        daily_limit: 1,
      }),
    );
    const j = await queueDraft(env, c.id, true);
    expect(await prepareRun(env, j!.id)).toBeTruthy();
    await run(
      env.DB,
      "UPDATE ai_runs SET updated_at=? WHERE id=?",
      Date.now() - 700000,
      j!.id,
    );
    await recoverDraftJobs(env);
    expect(
      (
        await one<{ state: string }>(
          env.DB,
          "SELECT state FROM ai_runs WHERE id=?",
          j!.id,
        )
      )?.state,
    ).toBe("failed");
    const next = await queueDraft(env, c.id, true);
    expect(await prepareRun(env, next!.id)).toBeNull();
    expect(
      (
        await one<{ reason: string }>(
          env.DB,
          "SELECT reason FROM ai_runs WHERE id=?",
          next!.id,
        )
      )?.reason,
    ).toContain("Daily");
  });
  it("limits reference lookup to active docs and eligible source paths", async () => {
    await setSetting(env, "ai_docs_generation", "active");
    await run(
      env.DB,
      "INSERT INTO ai_documents VALUES ('one','Chatbots','https://docs.example.com/chatbots','Enable the chatbot popup','active',1)",
    );
    await run(
      env.DB,
      "INSERT INTO ai_documents VALUES ('old','Chatbots','https://docs.example.com/chatbots','Wrong obsolete popup instructions','old',1)",
    );
    expect((await searchDocs(env, "chatbot popup")).map((s) => s.id)).toEqual([
      "doc:one",
    ]);
    for (const path of [
      ".env",
      "vendor/sdk/file.php",
      "lib/credentials.php",
      "../secret.php",
      "tests/fixtures/customer.json",
      "bundle.min.js",
    ])
      expect(allowedCodePath(path)).toBe(false);
    expect(allowedCodePath("lib/chatbot/settings.php")).toBe(true);
  });
  it("rejects automatic sending settings and keeps credentials out of settings responses", async () => {
    const { revision: _, enabled_at: __, ...config } = DEFAULT_AI;
    expect(
      (await request("/api/ai/settings", "PUT", { ...config, auto_send: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await request("/api/settings", "PUT", {
          github_token: "github_pat_test_only_secret",
        })
      ).status,
    ).toBe(200);
    const r = await request("/api/ai/settings");
    expect(await r.text()).not.toContain("github_pat_test_only_secret");
    await request("/api/settings/github", "DELETE");
    expect(
      await one(
        env.DB,
        "SELECT * FROM settings WHERE key='secret:github_token'",
      ),
    ).toBeNull();
  });
});
it("refreshes documentation atomically with safe Worker redirects and preserves the previous index on failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(
        String(input).endsWith("llms.txt")
          ? "https://docs.example.com/chatbots.md"
          : "# Chatbots\nEnable the popup in Display.",
      );
    }),
  );
  await syncDocumentation(env);
  expect(await searchDocs(env, "popup")).toHaveLength(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://untrusted.example/" },
        }),
    ),
  );
  await syncDocumentation(env);
  expect(await searchDocs(env, "popup")).toHaveLength(1);
  expect(
    (
      await one<{ value: string }>(
        env.DB,
        "SELECT value FROM settings WHERE key='ai_docs_error'",
      )
    )?.value,
  ).toContain("302");
});

describe("portable installation settings", () => {
  it("starts with neutral branding and no configured integrations or AI sources", async () => {
    await run(env.DB, "DELETE FROM settings");
    expect(await workspaceSettings(env)).toEqual(DEFAULT_WORKSPACE);
    const config = (await (await request("/api/settings")).json()) as Record<
      string,
      unknown
    >;
    expect(config.google_client_id).toBe("");
    expect(config.freemius_callback_url).toBe("");
    expect(config.freemius_product_id).toBe("");
    for (const key of [
      "google_client_secret",
      "freemius_callback_secret",
      "freemius_token",
      "mailchimp_key",
    ])
      expect(config[key + "_configured"]).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(
      (await customerIntegration(env, contact, "freemius", true)).state,
    ).toBe("unconfigured");
    expect(
      (await customerIntegration(env, contact, "mailchimp", true)).state,
    ).toBe("unconfigured");
    expect(fetchSpy).not.toHaveBeenCalled();
    const ai = (await (await request("/api/ai/settings")).json()) as {
      config: typeof DEFAULT_AI;
      github: { configured: boolean; repo: string; access: string };
    };
    expect(ai.config.enabled).toBe(false);
    expect(ai.github.repo).toBe("");
    expect(ai.github.access).toBe("public");
    expect(ai.config.use_github).toBe(false);
    expect(ai.config.documentation_index_url).toBe("");
    expect(ai.github.configured).toBe(false);
  });
  it("requires owner and Access bootstrap before exposing any app surface", async () => {
    for (const field of [
      "OWNER_EMAIL",
      "ACCESS_AUD",
      "ACCESS_TEAM_DOMAIN",
    ] as const)
      for (const path of [
        "/",
        "/api/settings",
        "/api/workspace",
        "/api/attachments/test",
        "/api/google/callback",
        "/assets/main.js",
      ]) {
        const r = await app.request(
          "https://support.example.com" + path,
          {},
          {
            ...env,
            LOCAL_DEV_AUTH: undefined,
            APP_ORIGIN: "https://support.example.com",
            [field]: "",
          },
        );
        expect(r.status).toBe(503);
      }
  });
  it("saves branding independently of login and applies only explicitly matched subject rules", async () => {
    const original = "[Plugin: northstar-plugin] [Plan: pro] [Bug] My question";
    expect(supportSubject(original)).toBe(original);
    expect(supportSubject(original, brand)).toBe(
      "[Northstar · Pro] — My question",
    );
    const other = {
      ...DEFAULT_WORKSPACE,
      name: "Cedar Support",
      product_name: "Cedar",
      subject_identifiers: ["cedar-plugin"],
      timezone: "America/New_York",
    };
    expect((await request("/api/workspace", "PUT", other)).status).toBe(200);
    expect(await workspaceSettings(env)).toEqual(other);
    expect(supportSubject(original, other)).toBe(original);
    expect(
      supportSubject(
        original.replace("northstar-plugin", "cedar-plugin"),
        other,
      ),
    ).toBe("[Cedar · Pro] — My question");
    expect(
      (
        await request("/api/workspace", "PUT", {
          ...other,
          owner_email: "intruder@example.com",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/workspace", "PUT", {
          ...other,
          logo: "data:image/svg+xml;base64,PHN2Zz4=",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/workspace", "PUT", {
          ...other,
          timezone: "Invalid/Zone",
        })
      ).status,
    ).toBe(400);
    expect(env.OWNER_EMAIL).toBe("owner@example.com");
  });
  it("accepts different Freemius products and prevents credentials leaving the provider host", () => {
    for (const id of ["12345", "67890"])
      expect(
        validateFreemiusCallback(
          `https://api.freemius.com/v1/developers/999/products/${id}/customer-lookup.json`,
        ),
      ).toContain(id);
    for (const url of [
      "https://evil.example.com/v1/developers/999/products/12345/customer-lookup.json",
      "https://api.freemius.com@evil.example.com/v1/developers/999/products/12345/customer-lookup.json",
    ])
      expect(() => validateFreemiusCallback(url)).toThrow();
  });
  it("validates configurable documentation origins and invalidates old references when the source changes", async () => {
    for (const url of [
      "http://docs.example.com/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://docs.local/",
      "https://user:password@docs.example.com/",
      "https://docs.example.com:8443/",
    ])
      expect(publicHttpsUrl(url)).toBe(false);
    expect(publicHttpsUrl("https://docs.example.com/llms.txt")).toBe(true);
    expect(
      documentationLink(
        "https://docs.example.com.evil.org/page",
        docsConfig.documentation_index_url,
      ),
    ).toBe(false);
    await setSetting(env, "ai_docs_generation", "active");
    const { revision: _revision, enabled_at: _enabledAt, ...body } = docsConfig;
    expect(
      (
        await request("/api/ai/settings", "PUT", {
          ...body,
          documentation_index_url: "https://docs.cedar.com/llms.txt",
        })
      ).status,
    ).toBe(200);
    expect(await searchDocs(env, "popup")).toEqual([]);
    expect(
      (await request("/api/ai/settings", "PUT", { ...body, enabled: true }))
        .status,
    ).toBe(409);
  });
  it("discards an index if its configured source changes during retrieval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("llms.txt"))
          return new Response(
            "[Guide](./guide.md)\n[Ignore](https://other.example.com/leak.md)",
          );
        await setSetting(
          env,
          "ai_config",
          JSON.stringify({
            ...docsConfig,
            documentation_index_url: "https://docs.cedar.com/llms.txt",
          }),
        );
        return new Response(
          "# Guide\nPrivate instructions for the old product",
        );
      }),
    );
    await syncDocumentation(env);
    expect(await all(env.DB, "SELECT * FROM ai_documents")).toEqual([]);
    expect(await searchDocs(env, "instructions")).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it("requires explicit opt-in before AI works without paid-customer verification", async () => {
    const c = await incoming("ai-generic");
    await setSetting(
      env,
      "ai_config",
      JSON.stringify({ ...DEFAULT_AI, enabled: true, revision: "paid" }),
    );
    const paidJob = await queueDraft(env, c.id, true);
    expect(await prepareRun(env, paidJob!.id)).toBeNull();
    await setSetting(
      env,
      "ai_config",
      JSON.stringify({
        ...DEFAULT_AI,
        enabled: true,
        revision: "all",
        eligibility: "all_customers",
      }),
    );
    const job = await queueDraft(env, c.id, true);
    const prepared = await prepareRun(env, job!.id);
    expect(prepared).toBeTruthy();
    await saveGeneratedDraft(env, prepared!, {
      reply: "Hello,\n\nPlease share the error message.",
      notes: "Needs details",
      sources: [],
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(await all(env.DB, "SELECT * FROM drafts")).toHaveLength(1);
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(0);
  });
});

describe("GitHub connections and AI reference consent", () => {
  const sha = "a".repeat(40);
  const githubResponse = (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/commits/")) return json({ sha });
    if (path.includes("/git/trees/"))
      return json({
        tree: [
          { type: "blob", mode: "100644", size: 90, path: "src/chatbot.ts" },
          { type: "blob", mode: "120000", path: "src/chatbot-link.ts" },
          { type: "blob", mode: "100644", path: "secret.php" },
        ],
        truncated: false,
      });
    if (path.includes("/contents/"))
      return json({
        encoding: "base64",
        content: Buffer.from(
          "export const chatbot = 'documented behavior';",
        ).toString("base64"),
        size: 90,
      });
    if (path.includes("/search/code"))
      return json({ items: [{ path: "src/chatbot.ts" }] });
    return json({ default_branch: "main" });
  };
  it("reads public repositories without sending a saved private token or calling authenticated code search", async () => {
    await saveSecret(env, "github_token", "private-test-token");
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        expect(init?.redirect).toBe("manual");
        expect(String(input)).not.toContain("/search/code");
        return githubResponse(input);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await githubHead(env, "example/project", "public")).toBe(sha);
    const sources = await searchCode(
      env,
      "example/project",
      sha,
      "chatbot",
      "public",
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBe("src/chatbot.ts");
    expect(sources[0].url).toContain(sha);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
  it("requires a token for private access and keeps it out of API responses", async () => {
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer private-test-token",
        );
        return githubResponse(input);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(githubHead(env, "example/project", "private")).rejects.toThrow(
      "token",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      (
        await request("/api/settings", "PUT", {
          github_repo: "example/project",
          github_access: "private",
          github_token: "private-test-token",
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/settings/github/check", "POST")).status).toBe(
      200,
    );
    expect(await (await request("/api/settings")).text()).not.toContain(
      "private-test-token",
    );
    expect(
      (await searchCode(env, "example/project", sha, "chatbot", "private"))[0]
        .title,
    ).toBe("src/chatbot.ts");
  });
  it("does not enable AI reference access just by connecting a repository", async () => {
    const { revision: _revision, enabled_at: _enabledAt, ...body } = DEFAULT_AI;
    expect(
      (await request("/api/ai/settings", "PUT", { ...body, use_github: true }))
        .status,
    ).toBe(409);
    await request("/api/settings", "PUT", {
      github_repo: "example/project",
      github_access: "public",
    });
    let result = (await (await request("/api/ai/settings")).json()) as {
      config: typeof DEFAULT_AI;
    };
    expect(result.config.use_github).toBe(false);
    expect(
      (await request("/api/ai/settings", "PUT", { ...body, use_github: true }))
        .status,
    ).toBe(200);
    await request("/api/settings/github", "DELETE");
    result = (await (await request("/api/ai/settings")).json()) as {
      config: typeof DEFAULT_AI;
    };
    expect(result.config.use_github).toBe(false);
  });
  it("invalidates running AI results when repository access changes", async () => {
    const c = await incoming("github-reference-race");
    await setSetting(
      env,
      "ai_config",
      JSON.stringify({
        ...DEFAULT_AI,
        enabled: true,
        revision: "initial",
        eligibility: "all_customers",
      }),
    );
    const job = await queueDraft(env, c.id, true);
    const prepared = await prepareRun(env, job!.id);
    expect(prepared).toBeTruthy();
    await request("/api/settings", "PUT", {
      github_repo: "example/other",
      github_access: "public",
    });
    await saveGeneratedDraft(env, prepared!, {
      reply: "Hello,\n\nOld repository reference.",
      notes: "",
      sources: [],
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(await all(env.DB, "SELECT * FROM drafts")).toHaveLength(0);
  });
});

describe("contacts directory", () => {
  const directory = async (query = "") => {
    const response = await request(`/api/contacts${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.json() as Promise<ContactsResult>;
  };
  it("automatically records a sender once across repeated messages and new threads", async () => {
    const mailbox = await getMailbox(env, "mailbox");
    for (const [id, threadId, sender] of [
      ["one", "one", "New Sender <New.Sender@example.test>"],
      ["one", "one", "New Sender <New.Sender@example.test>"],
      ["two", "two", "New Sender <new.sender@example.test>"],
    ]) {
      const mail = message(id, { threadId });
      mail.payload.headers![0].value = sender;
      await ingestMessage(env, mailbox, "token", mail, [inbox]);
    }
    const data = await directory("?q=NEW.SENDER");
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({
      name: "New Sender",
      email: "new.sender@example.test",
      conversation_count: 2,
    });
    expect(data.items[0].last_activity_at).toBeGreaterThan(0);
    expect(data.items[0]).not.toHaveProperty("freemius_email");
    const detail = (await (
      await request(`/api/contacts/${data.items[0].id}`)
    ).json()) as ContactHistory;
    expect(detail.items).toHaveLength(2);
    expect(
      detail.items.every((item) => item.contact_id === data.items[0].id),
    ).toBe(true);
    expect(
      await all(
        env.DB,
        "SELECT * FROM messages WHERE direction='inbound' AND LOWER(sender)='new.sender@example.test'",
      ),
    ).toHaveLength(2);
  });
  it("scopes membership, counts, dates and history to the selected inbox without deleting trashed contacts", async () => {
    await run(
      env.DB,
      "INSERT INTO inboxes(id,name,address,from_name,created_at) VALUES ('other','Other','other@example.test','Other',1)",
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO conversations(id,number,inbox_id,contact_id,subject,status,unread,deleted_at,created_at,updated_at) VALUES ('c1',1,'inbox','customer','First','open',1,NULL,1,100)",
      ),
      env.DB.prepare(
        "INSERT INTO conversations(id,number,inbox_id,contact_id,subject,status,unread,deleted_at,created_at,updated_at) VALUES ('c2',2,'other','customer','Other inbox','closed',0,NULL,1,200)",
      ),
      env.DB.prepare(
        "INSERT INTO conversations(id,number,inbox_id,contact_id,subject,status,unread,deleted_at,created_at,updated_at) VALUES ('c3',3,'inbox','customer','Deleted','closed',0,500,1,150)",
      ),
    ]);
    expect((await directory()).items[0]).toMatchObject({
      conversation_count: 3,
      last_activity_at: 200,
    });
    expect((await directory("?inbox=inbox")).items[0]).toMatchObject({
      conversation_count: 2,
      last_activity_at: 150,
    });
    const detail = (await (
      await request("/api/contacts/customer?inbox=inbox")
    ).json()) as ContactHistory;
    expect(detail.contact.conversation_count).toBe(2);
    expect(detail.items.map((item) => item.id)).toEqual(["c3", "c1"]);
    expect(detail.items[0].deleted_at).toBe(500);
    expect(
      (await one<Conversation>(
        env.DB,
        "SELECT * FROM conversations WHERE id='c1'",
      ))!.unread,
    ).toBe(1);
    expect((await directory("?inbox=missing")).total).toBe(0);
    const empty = (await (
      await request("/api/contacts/customer?inbox=missing")
    ).json()) as ContactHistory;
    expect(empty.contact.conversation_count).toBe(0);
    expect(empty.items).toEqual([]);
    expect((await request("/api/contacts/missing")).status).toBe(404);
  });
  it("searches literal names and addresses and paginates deterministic sorts", async () => {
    await env.DB.batch(
      Array.from({ length: 55 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO contacts(id,name,email,created_at) VALUES (?,?,?,1)",
        ).bind(
          `p${String(i).padStart(2, "0")}`,
          `Person ${String(i).padStart(2, "0")}`,
          `person${i}@example.test`,
        ),
      ),
    );
    const first = await directory("?sort=name&direction=asc");
    const next = await directory("?sort=name&direction=asc&offset=50");
    expect(first.total).toBe(56);
    expect(first.items).toHaveLength(50);
    expect(first.has_more).toBe(true);
    expect(next.items).toHaveLength(6);
    expect(next.has_more).toBe(false);
    expect(
      new Set([...first.items, ...next.items].map((item) => item.id)).size,
    ).toBe(56);
    expect((await directory("?sort=name&direction=desc")).items[0].id).toBe(
      "customer",
    );
    expect((await directory("?q=PERSON54@EXAMPLE.TEST")).total).toBe(1);
    await run(
      env.DB,
      "UPDATE contacts SET name='100%_coverage' WHERE id='customer'",
    );
    expect((await directory("?q=%25_")).items.map((item) => item.id)).toEqual([
      "customer",
    ]);
    expect((await directory("?q=' OR 1=1 --")).total).toBe(0);
    for (const query of [
      "?sort=unknown",
      "?direction=DROP",
      "?offset=-1",
      "?offset=Infinity",
      "?offset=1.5",
      `?q=${"a".repeat(151)}`,
    ])
      expect((await request(`/api/contacts${query}`)).status).toBe(400);
  });
  it("paginates one contact's history beyond fifty conversations", async () => {
    await env.DB.batch(
      Array.from({ length: 55 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO conversations(id,number,inbox_id,contact_id,subject,created_at,updated_at) VALUES (?,?, 'inbox','customer',?,1,?)",
        ).bind(`h${i}`, i + 1, `History ${i}`, i + 1),
      ),
    );
    const first = (await (
      await request("/api/contacts/customer")
    ).json()) as ContactHistory;
    const last = (await (
      await request("/api/contacts/customer?offset=50")
    ).json()) as ContactHistory;
    expect(first.contact.conversation_count).toBe(55);
    expect(first.items).toHaveLength(50);
    expect(first.has_more).toBe(true);
    expect(last.items).toHaveLength(5);
    expect(last.has_more).toBe(false);
    expect(
      new Set([...first.items, ...last.items].map((item) => item.id)).size,
    ).toBe(55);
    expect(first.items[0].id).toBe("h54");
    expect(last.items.at(-1)!.id).toBe("h0");
  });
});

describe("private email reports", () => {
  const date = () => new Date().toISOString().slice(0, 10);
  const reportQuery = () => `from=${date()}&to=${date()}`;
  async function readReport(extra = "") {
    const response = await request(`/api/reports?${reportQuery()}${extra}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return (await response.json()) as import("../src/shared/reports").Report;
  }
  it("captures actual send and bulk status changes once, then excludes Trash and reopened resolutions", async () => {
    const c = await incoming();
    await setSetting(env, "reporting_started_at", String(Date.now()));
    await mockGoogle();
    const job = await enqueueOutgoing(env, payload(c));
    await sendOutgoing(env, job.id);
    const closed = await readReport();
    expect(closed.metrics).toMatchObject({
      created: 1,
      received: 1,
      sent: 1,
      resolved: 1,
      helped: 1,
    });
    expect(closed.metrics.first_response.count).toBe(1);
    expect(closed.metrics.resolution.count).toBe(1);
    expect(
      await all(env.DB, "SELECT * FROM conversation_status_events"),
    ).toHaveLength(1);
    await request(`/api/conversations/${c.id}`, "PATCH", { status: "closed" });
    expect(
      await all(env.DB, "SELECT * FROM conversation_status_events"),
    ).toHaveLength(1);
    const current = await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE id=?",
      c.id,
    );
    const changed = await request("/api/conversations/bulk", "POST", {
      action: "waiting",
      items: [{ id: c.id, revision: current!.revision }],
    });
    expect(changed.status).toBe(200);
    expect((await readReport()).metrics.resolved).toBe(0);
    expect(
      await all(env.DB, "SELECT * FROM conversation_status_events"),
    ).toHaveLength(2);
    await run(
      env.DB,
      "UPDATE conversations SET deleted_at=? WHERE id=?",
      Date.now(),
      c.id,
    );
    const trashed = await readReport();
    expect(trashed.metrics).toMatchObject({
      active: 0,
      created: 0,
      received: 0,
      sent: 0,
      resolved: 0,
    });
    expect(trashed.backlog).toEqual({ open: 0, waiting: 0 });
  });
  it("acknowledgements and unsent or uncertain jobs never count as responses", async () => {
    const c = await incoming();
    await mockGoogle();
    const acknowledgement = await enqueueOutgoing(env, {
      ...payload(c, "auto-report"),
      kind: "auto",
    });
    await sendOutgoing(env, acknowledgement.id);
    const pending = await enqueueOutgoing(env, payload(c, "pending-report"));
    await run(
      env.DB,
      "UPDATE outgoing SET state='uncertain' WHERE id=?",
      pending.id,
    );
    const data = await readReport();
    expect(data.metrics).toMatchObject({
      received: 1,
      sent: 0,
      resolved: 0,
      helped: 0,
    });
    expect(data.metrics.first_response.count).toBe(0);
    expect(
      await all(env.DB, "SELECT * FROM conversation_status_events"),
    ).toHaveLength(0);
  });
  it("records incoming reopens, filters all metrics by inbox and exports only selected data", async () => {
    const c = await incoming();
    await run(
      env.DB,
      "UPDATE conversations SET status='closed' WHERE id=?",
      c.id,
    );
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("report-followup", { internalDate: String(Date.now() + 2) }),
      [inbox],
    );
    const transitions = await all<{ to_status: string }>(
      env.DB,
      "SELECT to_status FROM conversation_status_events ORDER BY changed_at",
    );
    expect(transitions.map((t) => t.to_status)).toEqual(["closed", "open"]);
    const data = await readReport("&inbox=missing");
    expect(data.metrics.active).toBe(0);
    expect(data.inboxes).toEqual([]);
    await run(
      env.DB,
      "UPDATE conversations SET subject=? WHERE id=?",
      '=HYPERLINK("https://example.test")',
      c.id,
    );
    const csv = await request(
      `/api/reports/export?${reportQuery()}&format=conversations&filter=created`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("cache-control")).toContain("no-store");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("\"'=HYPERLINK");
    const noMatches = await request(
      `/api/reports/export?${reportQuery()}&inbox=missing&format=conversations`,
    );
    expect((await noMatches.text()).trim().split("\r\n")).toHaveLength(1);
    const details = await request(
      `/api/reports/conversations?${reportQuery()}&filter=received`,
    );
    const detail = (await details.json()) as {
      items: { id: string }[];
      total: number;
    };
    expect(detail.total).toBe(1);
    expect(detail.items[0].id).toBe(c.id);
  });
  it("validates dates, paging, range caps and report filters", async () => {
    for (const q of [
      "from=2026-02-30&to=2026-03-01",
      "from=2025-01-01&to=2026-02-01",
      "from=2026-05-02&to=2026-05-01",
      "from=2099-01-01&to=2099-01-01",
      `${reportQuery()}&offset=-1`,
      `${reportQuery()}&filter=drop`,
      `${reportQuery()}&format=html`,
    ]) {
      expect((await request(`/api/reports?${q}`)).status).toBe(400);
    }
  });
  it("preserves the resolution ledger through backup restore and resets coverage for older snapshots", async () => {
    const c = await incoming();
    await run(
      env.DB,
      "UPDATE conversations SET status='waiting' WHERE id=?",
      c.id,
    );
    await run(
      env.DB,
      "UPDATE conversations SET status='closed' WHERE id=?",
      c.id,
    );
    await setSetting(env, "reporting_started_at", "100");
    const before = await all(
      env.DB,
      "SELECT * FROM conversation_status_events ORDER BY changed_at,id",
    );
    const snapshot: Record<string, Record<string, unknown>[]> = {};
    for (const table of BACKUP_TABLES)
      snapshot[table] = await all(env.DB, `SELECT * FROM ${table}`);
    await env.DB.batch(
      recoveryStatements(snapshot).map((s) => env.DB.prepare(s)),
    );
    expect(
      await all(
        env.DB,
        "SELECT * FROM conversation_status_events ORDER BY changed_at,id",
      ),
    ).toEqual(before);
    expect((await readReport()).reporting_started_at).toBe(100);
    delete snapshot.conversation_status_events;
    const started = Date.now();
    await env.DB.batch(
      recoveryStatements(snapshot).map((s) => env.DB.prepare(s)),
    );
    expect(
      await all(env.DB, "SELECT * FROM conversation_status_events"),
    ).toEqual([]);
    expect((await readReport()).reporting_started_at).toBeGreaterThanOrEqual(
      started,
    );
  });
  it("paginates drilldowns, exports every matching conversation, and scopes distinct customers", async () => {
    const timestamp = Date.now();
    await run(
      env.DB,
      "INSERT INTO inboxes(id,name,address,from_name,created_at) VALUES ('second','Billing','billing@example.test','Billing',?)",
      timestamp,
    );
    await run(
      env.DB,
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<52)
      INSERT INTO conversations(id,number,inbox_id,contact_id,subject,status,created_at,updated_at)
      SELECT 'report-'||x,x,CASE WHEN x=52 THEN 'second' ELSE 'inbox' END,'customer','Question '||x,'open',?,? FROM n`,
      timestamp,
      timestamp,
    );
    await run(
      env.DB,
      `INSERT INTO messages(id,conversation_id,direction,sender,sender_name,recipients,subject,body_key,search_text,sent_at)
      SELECT id||'-message',id,'inbound','customer@example.test','Customer','["support@example.com"]',subject,'','Private message text',? FROM conversations`,
      timestamp,
    );
    const data = await readReport();
    expect(data.metrics).toMatchObject({
      received: 52,
      customers: 1,
      active: 52,
    });
    expect(data.customers[0].conversations).toBe(52);
    expect(data.inboxes).toHaveLength(2);
    expect((await readReport("&inbox=second")).metrics).toMatchObject({
      received: 1,
      customers: 1,
      active: 1,
    });
    const page = (await (
      await request(
        `/api/reports/conversations?${reportQuery()}&inbox=inbox&offset=50`,
      )
    ).json()) as {
      items: { number: number }[];
      total: number;
      has_more: boolean;
    };
    expect(page).toMatchObject({ total: 51, has_more: false });
    expect(page.items.map((c) => c.number)).toEqual([1]);
    const csv = await (
      await request(
        `/api/reports/export?${reportQuery()}&format=conversations&inbox=inbox`,
      )
    ).text();
    expect(csv.trim().split("\r\n")).toHaveLength(52);
    expect(csv).not.toContain("Private message text");
  });
  it("rejects an oversized report instead of silently truncating totals", async () => {
    const timestamp = Date.now();
    await run(
      env.DB,
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO conversations(id,number,inbox_id,contact_id,subject,status,created_at,updated_at)
      SELECT 'limit-'||x,x,'inbox','customer','Question','open',?,? FROM n`,
      timestamp,
      timestamp,
    );
    const response = await request(`/api/reports?${reportQuery()}`);
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("shorter date range");
  });
});

describe("conversation previews and merging", () => {
  async function pair() {
    const target = await incoming("merge-first");
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("merge-second", { threadId: "second-thread" }),
      [inbox],
    );
    const source = (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE gmail_thread_id='second-thread'",
    ))!;
    return { target, source };
  }
  const merge = (target: Conversation, source: Conversation) =>
    request(`/api/conversations/${target.id}/merge`, "POST", {
      source_id: source.id,
      source_revision: source.revision,
      target_revision: target.revision,
    });
  const fresh = async (id: string) =>
    (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE id=?",
      id,
    ))!;

  it("previews without changing unread state, drafts, or the selected ticket", async () => {
    const { target, source } = await pair();
    await request(`/api/drafts/reply:${target.id}`, "PUT", {
      version: 0,
      conversation_id: target.id,
      payload: { text: "An unfinished reply" },
    });
    const before = await all(env.DB, "SELECT * FROM conversations ORDER BY id");
    const response = await request(`/api/conversations/${source.id}`);
    expect(response.status).toBe(200);
    expect(
      await all(env.DB, "SELECT * FROM conversations ORDER BY id"),
    ).toEqual(before);
    expect(await all(env.DB, "SELECT * FROM drafts")).toHaveLength(1);
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(0);
  });

  it("combines history, files, tracking and completed work while retaining the current draft and subject", async () => {
    const { target, source } = await pair();
    const sourceMessage = source.last_inbound_id!;
    await run(
      env.DB,
      "INSERT INTO attachments VALUES ('merge-file',?,?,'merge/file','details.txt','text/plain',7,NULL,1)",
      source.id,
      sourceMessage,
    );
    await env.FILES.put("merge/file", "Details");
    await run(
      env.DB,
      "INSERT INTO message_attachments VALUES (?, 'merge-file')",
      sourceMessage,
    );
    await enqueueOutgoing(env, payload(source));
    const job = (await one<Outgoing>(env.DB, "SELECT * FROM outgoing"))!;
    await markSent(env, job, "merge-sent", "second-thread");
    await run(
      env.DB,
      "INSERT INTO message_opens VALUES (?, 'merge-token', 'https://images.example.com/pixel.gif', 1234, 1)",
      job.id,
    );
    await run(
      env.DB,
      "INSERT INTO ai_runs(id,conversation_id,input_id,state,model,config_revision,ticket_status,created_at,updated_at) VALUES ('merge-ai',?,?,'draft','test','1','open',1,1)",
      source.id,
      sourceMessage,
    );
    await run(
      env.DB,
      "INSERT INTO events VALUES ('merge-delivery','delivery_failure',?,'Delivery issue',1)",
      source.id,
    );
    await run(
      env.DB,
      "UPDATE conversations SET status='closed',unread=0 WHERE id=?",
      target.id,
    );
    await run(
      env.DB,
      "UPDATE conversations SET status='waiting',unread=1 WHERE id=?",
      source.id,
    );
    const originalDraft = { text: "My review in progress", attachment_ids: [] };
    await request(`/api/drafts/reply:${target.id}`, "PUT", {
      version: 0,
      conversation_id: target.id,
      payload: originalDraft,
    });
    const response = await merge(
      await fresh(target.id),
      await fresh(source.id),
    );
    expect(await response.json()).toEqual({ conversation_id: target.id });
    expect(response.status).toBe(200);
    const combined = (await (
      await request(`/api/conversations/${source.id}`)
    ).json()) as import("../src/client/Conversation").Detail;
    expect(combined.conversation).toMatchObject({
      id: target.id,
      number: target.number,
      subject: target.subject,
      status: "waiting",
      unread: 1,
      last_inbound_id: sourceMessage,
    });
    expect(combined.messages).toHaveLength(3);
    expect(
      combined.messages.find((m) => m.id === sourceMessage)?.attachments?.[0]
        .id,
    ).toBe("merge-file");
    expect(
      combined.messages.find((m) => m.direction === "outbound")
        ?.first_opened_at,
    ).toBe(1234);
    expect(combined.events[0].detail).toBe("Delivery issue");
    expect(combined.history).toHaveLength(0);
    expect(await (await request("/api/attachments/merge-file")).text()).toBe(
      "Details",
    );
    expect(
      await one(
        env.DB,
        "SELECT conversation_id FROM ai_runs WHERE id='merge-ai'",
      ),
    ).toEqual({ conversation_id: target.id });
    expect(
      JSON.parse(
        (await one<{ payload: string }>(
          env.DB,
          "SELECT payload FROM outgoing",
        ))!.payload,
      ).conversation_id,
    ).toBe(target.id);
    expect(
      JSON.parse(
        (await one<{ payload: string }>(env.DB, "SELECT payload FROM drafts"))!
          .payload,
      ),
    ).toEqual(originalDraft);
    expect(await (await request("/api/conversations/counts")).json()).toEqual({
      waiting: 1,
    });
    expect(
      await (await request("/api/conversations?status=trash")).json(),
    ).toEqual({ items: [], has_more: false });
    const profile = (await (
      await request(`/api/contacts/${contact.id}`)
    ).json()) as ContactHistory;
    expect(profile.contact.conversation_count).toBe(1);
    expect(profile.items.map((c) => c.id)).toEqual([target.id]);
    expect(
      (
        (await (
          await request("/api/conversations/bulk", "POST", {
            action: "restore",
            items: [
              { id: source.id, revision: (await fresh(source.id)).revision },
            ],
          })
        ).json()) as { updated: string[] }
      ).updated,
    ).toEqual([]);
    expect(
      (
        await request(`/api/drafts/reply:${source.id}`, "PUT", {
          version: 0,
          conversation_id: source.id,
          payload: { text: "Stale tab" },
        })
      ).status,
    ).toBe(404);
    await expect(
      enqueueOutgoing(env, payload(source, "stale-send")),
    ).rejects.toThrow();
    expect(await one(env.DB, "SELECT lease_until FROM mailboxes")).toEqual({
      lease_until: 0,
    });
  });

  it("keeps replies to both Gmail threads together and old links working through subsequent merges", async () => {
    const { target, source } = await pair();
    expect((await merge(target, source)).status).toBe(200);
    expect((await merge(target, source)).status).toBe(200);
    for (const threadId of ["thread", "second-thread"]) {
      await ingestMessage(
        env,
        await getMailbox(env, "mailbox"),
        "token",
        message(`new-${threadId}`, { threadId }),
        [inbox],
      );
    }
    expect(
      await all(env.DB, "SELECT DISTINCT conversation_id FROM messages"),
    ).toEqual([{ conversation_id: target.id }]);
    expect(await all(env.DB, "SELECT * FROM outgoing")).toHaveLength(0);
    await ingestMessage(
      env,
      await getMailbox(env, "mailbox"),
      "token",
      message("third-message", { threadId: "third-thread" }),
      [inbox],
    );
    const third = (await one<Conversation>(
      env.DB,
      "SELECT * FROM conversations WHERE gmail_thread_id='third-thread'",
    ))!;
    expect((await merge(third, await fresh(target.id))).status).toBe(200);
    expect((await fresh(source.id)).merged_into).toBe(third.id);
    const oldLink = (await (
      await request(`/api/conversations/${source.id}`)
    ).json()) as import("../src/client/Conversation").Detail;
    expect(oldLink.conversation.id).toBe(third.id);
    expect(oldLink.messages).toHaveLength(5);
    expect(
      await all(env.DB, "SELECT DISTINCT conversation_id FROM thread_links"),
    ).toEqual([{ conversation_id: third.id }]);
    const snapshot = Object.fromEntries(
      await Promise.all(
        BACKUP_TABLES.map(async (table) => [
          table,
          await all<Record<string, unknown>>(env.DB, `SELECT * FROM ${table}`),
        ]),
      ),
    );
    await env.DB.batch(
      recoveryStatements(snapshot).map((sql) => env.DB.prepare(sql)),
    );
    expect((await fresh(source.id)).merged_into).toBe(third.id);
    expect(
      await all(env.DB, "SELECT DISTINCT conversation_id FROM thread_links"),
    ).toEqual([{ conversation_id: third.id }]);
  });

  it.each([
    "draft",
    "send",
    "uncertain",
    "failed",
    "ai",
    "lease",
    "revision",
    "trash",
    "customer",
    "inbox",
    "mailbox",
  ])("rejects an unsafe merge: %s", async (blocker) => {
    const { target, source } = await pair();
    if (blocker === "draft")
      await request(`/api/drafts/reply:${source.id}`, "PUT", {
        version: 0,
        conversation_id: source.id,
        payload: { text: "Keep this" },
      });
    if (["send", "uncertain", "failed"].includes(blocker)) {
      await enqueueOutgoing(env, payload(source));
      if (blocker !== "send")
        await run(env.DB, "UPDATE outgoing SET state=?", blocker);
    }
    if (blocker === "ai")
      await run(
        env.DB,
        "INSERT INTO ai_runs(id,conversation_id,input_id,model,config_revision,ticket_status,created_at,updated_at) VALUES ('busy-ai',?,?,'test','1','open',1,1)",
        target.id,
        target.last_inbound_id,
      );
    if (blocker === "lease")
      await run(
        env.DB,
        "UPDATE mailboxes SET lease_owner='sync',lease_until=?",
        Date.now() + 120000,
      );
    if (blocker === "revision")
      await run(
        env.DB,
        "UPDATE conversations SET revision=revision+1 WHERE id=?",
        source.id,
      );
    if (blocker === "trash")
      await run(
        env.DB,
        "UPDATE conversations SET deleted_at=1 WHERE id=?",
        source.id,
      );
    if (blocker === "customer") {
      await run(
        env.DB,
        "INSERT INTO contacts(id,name,email,created_at) VALUES ('other','Other','other@example.test',1)",
      );
      await run(
        env.DB,
        "UPDATE conversations SET contact_id='other' WHERE id=?",
        source.id,
      );
    }
    if (blocker === "inbox") {
      await run(
        env.DB,
        "INSERT INTO inboxes(id,name,address,from_name,created_at) VALUES ('other','Other','other@example.test','Other',1)",
      );
      await run(
        env.DB,
        "UPDATE conversations SET inbox_id='other' WHERE id=?",
        source.id,
      );
    }
    if (blocker === "mailbox")
      await run(
        env.DB,
        "UPDATE conversations SET mailbox_id=NULL WHERE id=?",
        source.id,
      );
    expect((await merge(target, source)).status).toBe(409);
    expect(
      await all(
        env.DB,
        "SELECT * FROM messages WHERE conversation_id=?",
        source.id,
      ),
    ).toHaveLength(1);
    expect((await fresh(source.id)).merged_into).toBeNull();
    expect(
      await all(
        env.DB,
        "SELECT * FROM events WHERE kind='conversation_merged'",
      ),
    ).toHaveLength(0);
  });

  it.each(["draft", "incoming"])(
    "rechecks %s changes atomically after preflight",
    async (change) => {
      const { target, source } = await pair();
      const { mergeConversations } =
        await import("../src/worker/conversation-merge");
      const db = new Proxy(env.DB, {
        get(db, prop) {
          if (prop === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (change === "draft")
                await run(
                  env.DB,
                  "INSERT INTO drafts VALUES (?,?,?,1,1)",
                  `reply:${source.id}`,
                  source.id,
                  JSON.stringify({ text: "Just typed" }),
                );
              else
                await run(
                  env.DB,
                  "UPDATE conversations SET revision=revision+1 WHERE id=?",
                  target.id,
                );
              return db.batch(statements);
            };
          const value = Reflect.get(db, prop, db);
          return typeof value === "function" ? value.bind(db) : value;
        },
      });
      await expect(
        mergeConversations(
          { ...env, DB: db },
          target.id,
          source.id,
          target.revision,
          source.revision,
        ),
      ).rejects.toThrow("changed or has unfinished work");
      expect(
        await all(
          env.DB,
          "SELECT * FROM messages WHERE conversation_id=?",
          source.id,
        ),
      ).toHaveLength(1);
      expect((await fresh(source.id)).merged_into).toBeNull();
      expect(await one(env.DB, "SELECT lease_until FROM mailboxes")).toEqual({
        lease_until: 0,
      });
    },
  );
});
