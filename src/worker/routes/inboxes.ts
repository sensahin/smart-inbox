import { workspaceSettings } from "../workspace";
import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { DEFAULT_ACK, type Inbox } from "../../shared/types";
import {
  all,
  AppError,
  normalizeEmail,
  now,
  one,
  recordEvent,
  run,
  uid,
} from "../db";
import { base64url, decrypt, encrypt, sha256 } from "../secrets";
import {
  exchangeCode,
  gmail,
  googleCredentials,
  verifiedSendingAddress,
} from "../google";
export const inboxRoutes = new Hono<Bindings>();
inboxRoutes.get("/inboxes", async (c) =>
  c.json(
    await all<Inbox>(
      c.env.DB,
      "SELECT * FROM inboxes ORDER BY routing_priority,name",
    ),
  ),
);
const inboxSchema = z
  .object({
    name: z.string().min(1).max(100),
    address: z.string().email().transform(normalizeEmail),
    mailbox_id: z.string().nullable(),
    from_name: z.string().min(1).max(100),
    signature: z.string().max(10000).default(""),
    signature_aliases: z.number().int().min(0).max(1).default(1),
    default_status: z.enum(["open", "waiting", "closed"]).default("closed"),
    auto_bcc: z.string().max(2000).default(""),
    auto_reply: z.string().max(20000).default(DEFAULT_ACK),
    auto_reply_mode: z
      .enum(["always", "outside_hours", "off"])
      .default("always"),
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      })
      .default("UTC"),
    office_start: z.number().int().min(0).max(23).default(9),
    office_end: z.number().int().min(1).max(24).default(17),
    routing_priority: z.number().int().min(0).max(10000).default(100),
  })
  .refine(
    (v) => v.office_start < v.office_end,
    "Office end must be after start.",
  );
inboxRoutes.put("/inboxes/:id", async (c) => {
  const body = inboxSchema.parse(await c.req.json());
  if (body.mailbox_id) {
    const mailbox = await one<{ aliases: string; email: string }>(
      c.env.DB,
      "SELECT aliases,email FROM mailboxes WHERE id=?",
      body.mailbox_id,
    );
    if (!mailbox || !verifiedSendingAddress(mailbox, body.address))
      throw new AppError(
        400,
        "Choose a verified sending address from the connected mailbox.",
      );
  }
  const id = c.req.param("id") === "new" ? uid() : c.req.param("id");
  const existing = await one<Inbox>(
    c.env.DB,
    "SELECT * FROM inboxes WHERE id=?",
    id,
  );
  if (
    existing &&
    existing.mailbox_id !== body.mailbox_id &&
    (await one(
      c.env.DB,
      "SELECT id FROM conversations WHERE inbox_id=? LIMIT 1",
      id,
    ))
  )
    throw new AppError(
      409,
      "An inbox with conversations cannot be moved to another mailbox. Create a new inbox instead.",
    );
  const keys = Object.keys(body);
  const values = Object.values(body);
  await run(
    c.env.DB,
    `INSERT INTO inboxes(id,${keys.join(",")},created_at) VALUES (?,${keys.map(() => "?").join(",")},?) ON CONFLICT(id) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`).join(",")}`,
    id,
    ...values,
    now(),
  );
  return c.json({ id });
});
inboxRoutes.post("/google/connect", async (c) => {
  const credentials = await googleCredentials(c.env);
  if (!credentials.clientId || !credentials.clientSecret)
    throw new AppError(
      400,
      "Save your Google OAuth client ID and secret in Settings first.",
    );
  const state = base64url(crypto.getRandomValues(new Uint8Array(32))),
    verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await run(
    c.env.DB,
    "INSERT INTO oauth_states VALUES (?,?,?,?)",
    await sha256(state),
    await encrypt(c.env, verifier),
    c.get("owner"),
    now() + 600000,
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: `${c.env.APP_ORIGIN}/api/google/callback`,
    response_type: "code",
    scope:
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent select_account",
    hd: c.env.WORKSPACE_DOMAIN,
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.json({ url: url.href });
});
inboxRoutes.get("/google/callback", async (c) => {
  const rawState = c.req.query("state"),
    code = c.req.query("code");
  if (!rawState || !code)
    throw new AppError(
      400,
      "Google connection was cancelled or is missing authorization.",
    );
  const state = await one<{
    verifier: string;
    owner_email: string;
    expires_at: number;
  }>(
    c.env.DB,
    "DELETE FROM oauth_states WHERE state_hash=? RETURNING *",
    await sha256(rawState),
  );
  if (
    !state ||
    state.expires_at < now() ||
    state.owner_email !== c.get("owner")
  )
    throw new AppError(
      400,
      "This Google connection link expired. Start again from Settings.",
    );
  const tokens = await exchangeCode(
    c.env,
    code,
    await decrypt(c.env, state.verifier),
  );
  if (!tokens.refresh_token)
    throw new AppError(
      400,
      "Google did not grant offline access. Reconnect and approve all permissions.",
    );
  if (
    !tokens.scope.includes("gmail.readonly") ||
    !tokens.scope.includes("gmail.send")
  )
    throw new AppError(
      400,
      "Both Gmail reading and sending permissions are required.",
    );
  const profile = await gmail<{ emailAddress: string; historyId: string }>(
    tokens.access_token,
    "profile",
  );
  const email = normalizeEmail(profile.emailAddress);
  if (
    c.env.WORKSPACE_DOMAIN &&
    email.split("@")[1] !== c.env.WORKSPACE_DOMAIN.toLowerCase()
  )
    throw new AppError(403, `Connect a mailbox in ${c.env.WORKSPACE_DOMAIN}.`);
  const aliases = await gmail<{
    sendAs: {
      sendAsEmail: string;
      verificationStatus: string;
      isPrimary: boolean;
      displayName: string;
    }[];
  }>(tokens.access_token, "settings/sendAs");
  const previous = await one<{ id: string }>(
    c.env.DB,
    "SELECT id FROM mailboxes WHERE email=?",
    email,
  );
  const id = previous?.id || uid();
  const timestamp = now();
  await run(
    c.env.DB,
    "INSERT INTO mailboxes(id,email,refresh_token,history_id,cutover_at,aliases,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET refresh_token=excluded.refresh_token,aliases=excluded.aliases,state='connected',error=NULL",
    id,
    email,
    await encrypt(c.env, tokens.refresh_token),
    profile.historyId,
    timestamp,
    JSON.stringify(aliases.sendAs),
    timestamp,
  );
  // Preserve an existing inbox definition created before OAuth setup.
  await run(
    c.env.DB,
    "UPDATE inboxes SET mailbox_id=? WHERE mailbox_id IS NULL AND address=?",
    id,
    email,
  );
  const workspace = await workspaceSettings(c.env);
  if (!(await one(c.env.DB, "SELECT id FROM inboxes WHERE mailbox_id=?", id)))
    await run(
      c.env.DB,
      "INSERT INTO inboxes(id,mailbox_id,name,address,from_name,auto_reply,timezone,created_at) VALUES (?,?,?,?,?,?,?,?)",
      uid(),
      id,
      workspace.name,
      email,
      workspace.name,
      DEFAULT_ACK,
      workspace.timezone,
      timestamp,
    );
  await recordEvent(
    c.env,
    "mailbox_connected",
    id,
    "Mailbox connected. Existing cutover and history retained on reconnection.",
  );
  return c.redirect(`${c.env.APP_ORIGIN}/?view=settings&connected=1`);
});
inboxRoutes.post("/mailboxes/:id/sync", async (c) => {
  await c.env.JOBS.send({ type: "sync", mailboxId: c.req.param("id") });
  return c.json({ ok: true });
});
inboxRoutes.post("/mailboxes/:id/disconnect", async (c) => {
  await run(
    c.env.DB,
    "UPDATE mailboxes SET state='disconnected',refresh_token='',error='Disconnected by owner.' WHERE id=?",
    c.req.param("id"),
  );
  return c.json({ ok: true });
});
