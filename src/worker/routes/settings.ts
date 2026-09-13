import { githubConnection, githubRepoSchema } from "../github";
import { trackingOrigin } from "../open-tracking";
import { githubHead, githubJson, githubFiles } from "../ai/knowledge";
import type { AppEnv } from "../env";
import { workspaceSchema, workspaceSettings } from "../workspace";
import { reconcileRestore } from "../recovery";
import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import type { Health, Mailbox, Outgoing, SavedReply } from "../../shared/types";
import {
  all,
  AppError,
  now,
  one,
  recordEvent,
  run,
  setting,
  setSetting,
  uid,
} from "../db";
import { encrypt } from "../secrets";
import {
  validateFreemiusCallback,
  validateSignatureHeader,
} from "../integrations";
const secrets = [
  "google_client_secret",
  "freemius_callback_secret",
  "freemius_token",
  "mailchimp_key",
  "github_token",
] as const;
const publicKeys = [
  "google_client_id",
  "freemius_mode",
  "freemius_callback_url",
  "freemius_signature_header",
  "freemius_product_id",
  "github_repo",
  "github_access",
] as const;
export const settingsRoutes = new Hono<Bindings>();
settingsRoutes.get("/workspace", async (c) =>
  c.json(await workspaceSettings(c.env)),
);
settingsRoutes.put("/workspace", async (c) => {
  const body = workspaceSchema.parse(await c.req.json());
  await setSetting(c.env, "workspace", JSON.stringify(body));
  return c.json(body);
});
settingsRoutes.get("/settings", async (c) => {
  const config: Record<string, string | boolean> = {};
  for (const key of publicKeys)
    config[key] = await setting(
      c.env,
      key,
      key === "freemius_mode" ? "api" : key === "github_access" ? "public" : "",
    );
  for (const key of secrets)
    config[`${key}_configured`] = !!(await setting(c.env, `secret:${key}`));
  return c.json({
    ...config,
    github_checked: await setting(c.env, "github_checked"),
    owner_email: c.env.OWNER_EMAIL,
    redirect_uri: `${c.env.APP_ORIGIN}/api/google/callback`,
    encryption_configured: !!c.env.ENCRYPTION_KEY,
  });
});
settingsRoutes.put("/settings", async (c) => {
  const body = z
    .object({
      google_client_id: z.string().max(300).optional(),
      google_client_secret: z.string().max(1000).optional(),
      freemius_product_id: z.string().regex(/^\d*$/).max(30).optional(),
      freemius_mode: z.enum(["callback", "api"]).optional(),
      freemius_callback_url: z.string().max(500).optional(),
      freemius_signature_header: z.string().max(64).optional(),
      freemius_callback_secret: z.string().max(1000).optional(),
      freemius_token: z.string().max(2000).optional(),
      mailchimp_key: z.string().max(1000).optional(),
      github_repo: githubRepoSchema.optional(),
      github_access: z.enum(["public", "private"]).optional(),
      github_token: z.string().max(500).optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (body.freemius_callback_url)
    validateFreemiusCallback(body.freemius_callback_url);
  if (body.freemius_signature_header)
    validateSignatureHeader(body.freemius_signature_header);
  const statements = [];
  for (const key of publicKeys)
    if (body[key] !== undefined)
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(key, body[key]!),
      );
  for (const key of secrets)
    if (body[key])
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(`secret:${key}`, await encrypt(c.env, body[key]!)),
      );
  if (
    body.github_repo !== undefined ||
    body.github_access !== undefined ||
    body.github_token
  )
    statements.push(...githubChanged(c.env));
  statements.push(c.env.DB.prepare("DELETE FROM integration_snapshots"));
  await c.env.DB.batch(statements);
  await recordEvent(
    c.env,
    "settings_updated",
    null,
    "Integration settings updated.",
  );
  return c.json({ ok: true });
});
function githubChanged(env: AppEnv) {
  const revision = uid();
  return [
    env.DB.prepare(
      "INSERT INTO settings(key,value) VALUES ('github_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(revision),
    env.DB.prepare("DELETE FROM settings WHERE key='github_checked'"),
    env.DB.prepare(
      "UPDATE settings SET value=json_set(value,'$.revision',?) WHERE key='ai_config'",
    ).bind(revision),
    env.DB.prepare(
      "UPDATE ai_runs SET state='skipped',reason='GitHub connection changed. Generate again if needed.',updated_at=? WHERE state='queued'",
    ).bind(now()),
  ];
}
settingsRoutes.delete("/settings/github", async (c) => {
  await c.env.DB.batch([
    ...githubChanged(c.env),
    c.env.DB.prepare(
      "DELETE FROM settings WHERE key IN ('github_repo','github_access','secret:github_token')",
    ),
    c.env.DB.prepare(
      "UPDATE settings SET value=json_set(value,'$.use_github',json('false')) WHERE key='ai_config'",
    ),
  ]);
  return c.json({ ok: true });
});
settingsRoutes.post("/settings/github/check", async (c) => {
  const config = await githubConnection(c.env);
  const sha = await githubHead(c.env, config.repo, config.access);
  const path = (await githubFiles(c.env, config.repo, sha, config.access))[0]
    ?.path;
  if (!path)
    throw new AppError(
      502,
      "No supported source files were found in this repository.",
    );
  const file = await githubJson<{ encoding: string; content: string }>(
    c.env,
    `/repos/${config.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
    config.access,
  );
  if (file.encoding !== "base64" || typeof file.content !== "string")
    throw new AppError(
      502,
      "Source content could not be read. Check repository access.",
    );
  await run(
    c.env.DB,
    "INSERT INTO settings(key,value) SELECT 'github_checked',? WHERE EXISTS(SELECT 1 FROM settings WHERE key='github_revision' AND value=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify({
      repo: config.repo,
      access: config.access,
      sha,
      at: now(),
    }),
    config.revision,
  );
  return c.json({ sha });
});
settingsRoutes.get("/health", async (c) => {
  const mailboxes = await all<Mailbox>(
    c.env.DB,
    "SELECT id,email,aliases,history_id,cutover_at,state,last_sync_at,error,created_at FROM mailboxes",
  );
  const jobs = await all<Outgoing>(
    c.env.DB,
    "SELECT id,conversation_id,kind,state,error,attempts,created_at,updated_at FROM outgoing WHERE state<>'sent' ORDER BY created_at DESC LIMIT 100",
  );
  const configured: Record<string, boolean> = {};
  for (const key of secrets)
    configured[key] = !!(await setting(c.env, `secret:${key}`));
  const result: Health = {
    open_tracking_enabled:
      (await setting(c.env, "open_tracking_enabled")) === "true",
    open_tracking_available: !!trackingOrigin(c.env),
    sending_enabled: (await setting(c.env, "sending_enabled")) === "true",
    acknowledgements_enabled:
      (await setting(c.env, "acknowledgements_enabled")) === "true",
    restore_reconciled: (await setting(c.env, "restore_reconciled")) === "true",
    mailboxes,
    jobs,
    backup_error: await setting(c.env, "backup_error"),
    backup: JSON.parse(await setting(c.env, "last_backup", "null")),
    configured,
  };
  return c.json(result);
});
settingsRoutes.put("/operations", async (c) => {
  const body = z
    .object({
      sending_enabled: z.boolean().optional(),
      acknowledgements_enabled: z.boolean().optional(),
      open_tracking_enabled: z.boolean().optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (body.open_tracking_enabled && !trackingOrigin(c.env))
    throw new AppError(
      409,
      "Configure the separate open-tracking Worker before enabling tracking.",
    );
  if (
    body.sending_enabled &&
    (await setting(c.env, "restore_reconciled")) !== "true"
  )
    throw new AppError(
      409,
      "Complete restore reconciliation before enabling sending.",
    );
  for (const [key, value] of Object.entries(body))
    await setSetting(c.env, key, String(value));
  await recordEvent(c.env, "operations_updated", null, JSON.stringify(body));
  return c.json({ ok: true });
});
settingsRoutes.get("/saved-replies", async (c) =>
  c.json(
    await all<SavedReply>(
      c.env.DB,
      "SELECT * FROM saved_replies ORDER BY title COLLATE NOCASE",
    ),
  ),
);
settingsRoutes.put("/saved-replies/:id", async (c) => {
  const body = z
    .object({
      title: z.string().min(1).max(100),
      body: z.string().min(1).max(20000),
    })
    .parse(await c.req.json());
  const id = c.req.param("id") === "new" ? uid() : c.req.param("id");
  await run(
    c.env.DB,
    "INSERT INTO saved_replies VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at",
    id,
    body.title,
    body.body,
    now(),
  );
  return c.json({ id });
});
settingsRoutes.delete("/saved-replies/:id", async (c) => {
  await run(
    c.env.DB,
    "DELETE FROM saved_replies WHERE id=?",
    c.req.param("id"),
  );
  return c.json({ ok: true });
});
settingsRoutes.get("/events", async (c) =>
  c.json(
    await all(
      c.env.DB,
      "SELECT * FROM events ORDER BY created_at DESC LIMIT 50",
    ),
  ),
);
settingsRoutes.get("/drafts/:id", async (c) =>
  c.json(
    await one(c.env.DB, "SELECT * FROM drafts WHERE id=?", c.req.param("id")),
  ),
);
settingsRoutes.put("/drafts/:id", async (c) => {
  const body = z
    .object({
      version: z.number().int().min(0),
      conversation_id: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
    })
    .parse(await c.req.json());
  const payload = JSON.stringify(body.payload);
  if (payload.length > 250000) throw new AppError(400, "Draft is too large.");
  if (
    body.conversation_id &&
    !(await one(
      c.env.DB,
      "SELECT id FROM conversations WHERE id=? AND merged_into IS NULL",
      body.conversation_id,
    ))
  )
    throw new AppError(404, "Conversation not found.");
  const result =
    body.version === 0
      ? await run(
          c.env.DB,
          "INSERT OR IGNORE INTO drafts SELECT ?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM conversations WHERE id=? AND merged_into IS NULL)",
          c.req.param("id"),
          body.conversation_id,
          payload,
          1,
          now(),
          body.conversation_id,
          body.conversation_id,
        )
      : await run(
          c.env.DB,
          "UPDATE drafts SET payload=?,version=version+1,updated_at=? WHERE id=? AND version=? AND conversation_id IS ? AND (conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations WHERE id=drafts.conversation_id AND merged_into IS NULL))",
          payload,
          now(),
          c.req.param("id"),
          body.version,
          body.conversation_id,
        );
  if (!result.meta.changes)
    throw new AppError(
      409,
      "This draft changed in another tab. Reload the saved draft before editing.",
    );
  return c.json({ version: body.version + 1 });
});
settingsRoutes.delete("/drafts/:id", async (c) => {
  const version = Number(c.req.query("version"));
  if (!Number.isInteger(version))
    throw new AppError(400, "Draft version is required.");
  const r = await run(
    c.env.DB,
    "DELETE FROM drafts WHERE id=? AND version=?",
    c.req.param("id"),
    version,
  );
  if (!r.meta.changes) throw new AppError(409, "Draft changed in another tab.");
  return c.json({ ok: true });
});

settingsRoutes.post("/recovery/reconcile", async (c) =>
  c.json(await reconcileRestore(c.env)),
);
settingsRoutes.post("/backup", async (c) => {
  await c.env.JOBS.send({ type: "backup" });
  return c.json({ ok: true });
});
