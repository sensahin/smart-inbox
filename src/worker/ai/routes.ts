import { githubConnection } from "../github";
import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { AI_MODELS, type AIRun } from "../../shared/ai";
import { all, AppError, now, one, parseJson, setting, uid } from "../db";
import { aiConfig, configSchema } from "./config";
import { queueDraft } from "./jobs";
import { redactReference } from "./eligibility";
export const aiRoutes = new Hono<Bindings>();
aiRoutes.get("/ai/settings", async (c) => {
  const config = await aiConfig(c.env);
  const today = await one<{
    count: number;
    input_tokens: number;
    output_tokens: number;
  }>(
    c.env.DB,
    "SELECT COUNT(*) count,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens FROM ai_runs WHERE started_at>=?",
    new Date().setUTCHours(0, 0, 0, 0),
  );
  return c.json({
    config,
    model_check: parseJson(await setting(c.env, "ai_model_check"), null),
    models: AI_MODELS,
    github: await githubConnection(c.env),
    docs_updated: Number(await setting(c.env, "ai_docs_updated")) || null,
    docs_error: await setting(c.env, "ai_docs_error"),
    docs_busy: Number(await setting(c.env, "ai_docs_lease")) > now(),
    today,
    runs: await all(
      c.env.DB,
      "SELECT id,conversation_id,state,reason,model,created_at,input_tokens,output_tokens FROM ai_runs ORDER BY created_at DESC LIMIT 30",
    ),
  });
});
aiRoutes.put("/ai/settings", async (c) => {
  const body = configSchema.parse(await c.req.json());
  const old = await aiConfig(c.env);
  if (body.enabled && (await setting(c.env, "restore_reconciled")) !== "true")
    throw new AppError(
      409,
      "Complete restore reconciliation before enabling AI.",
    );
  if (
    body.enabled &&
    (!body.documentation_index_url ||
      body.documentation_index_url !==
        (await setting(c.env, "ai_docs_index_url")) ||
      !(await setting(c.env, "ai_docs_generation")))
  )
    throw new AppError(409, "Refresh documentation before enabling AI drafts.");
  if (body.use_github && !(await githubConnection(c.env)).configured)
    throw new AppError(
      409,
      "Configure GitHub in Connections before enabling it as a reference.",
    );
  const config = {
    ...body,
    enabled_at: body.enabled && !old.enabled ? now() : old.enabled_at,
    revision: uid(),
  };
  const sourceChanged =
    body.documentation_index_url !== old.documentation_index_url;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO settings(key,value) VALUES ('ai_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(JSON.stringify(config)),
    c.env.DB.prepare(
      "INSERT INTO settings(key,value) VALUES ('ai_paused','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ),
    ...(sourceChanged
      ? [
          c.env.DB.prepare(
            "DELETE FROM settings WHERE key IN ('ai_docs_generation','ai_docs_updated','ai_docs_index_url','ai_docs_error')",
          ),
        ]
      : []),
    c.env.DB.prepare(
      "UPDATE ai_runs SET state='skipped',reason='AI settings changed. Generate again if needed.',updated_at=? WHERE state='queued'",
    ).bind(now()),
  ]);
  return c.json({ config });
});
aiRoutes.post("/ai/documentation/refresh", async (c) => {
  if (!(await aiConfig(c.env)).documentation_index_url)
    throw new AppError(409, "Save a documentation index URL first.");
  await c.env.AI_JOBS.send({ type: "ai-docs" });
  return c.json({ ok: true }, 202);
});
aiRoutes.get("/ai/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const draftRun = await one<AIRun>(
    c.env.DB,
    "SELECT r.* FROM ai_runs r JOIN drafts d ON json_extract(d.payload,'$.ai_run_id')=r.id WHERE d.id=? AND r.conversation_id=?",
    `reply:${id}`,
    id,
  );
  const requested = c.req.query("run");
  const loadedRun = requested
    ? await one<AIRun>(
        c.env.DB,
        "SELECT * FROM ai_runs WHERE id=? AND conversation_id=?",
        requested,
        id,
      )
    : null;
  return c.json({
    enabled: (await aiConfig(c.env)).enabled,
    draft_available: !!draftRun,
    run:
      loadedRun ||
      draftRun ||
      (await one(
        c.env.DB,
        "SELECT * FROM ai_runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1",
        id,
      )),
  });
});
aiRoutes.post("/ai/conversations/:id/generate", async (c) =>
  c.json(await queueDraft(c.env, c.req.param("id"), true), 202),
);
aiRoutes.get("/ai/sources/history/:id", async (c) => {
  const m = await one<{ search_text: string }>(
    c.env.DB,
    "SELECT m.search_text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.direction='outbound' AND c.deleted_at IS NULL",
    c.req.param("id"),
  );
  if (!m) throw new AppError(404, "Source is no longer available.");
  return c.text(redactReference(m.search_text));
});
aiRoutes.get("/drafts", async (c) => {
  const rows = await all<{
    id: string;
    conversation_id: string | null;
    payload: string;
    version: number;
    updated_at: number;
    contact_name: string;
    subject: string;
  }>(
    c.env.DB,
    `SELECT d.*,p.name contact_name,c.subject FROM drafts d LEFT JOIN conversations c ON c.id=d.conversation_id LEFT JOIN contacts p ON p.id=c.contact_id WHERE (d.conversation_id IS NULL OR c.deleted_at IS NULL) AND (COALESCE(json_extract(d.payload,'$.text'),'')<>'' OR COALESCE(json_array_length(json_extract(d.payload,'$.attachment_ids')),0)>0) ORDER BY d.updated_at DESC LIMIT 100`,
  );
  return c.json(
    rows.map((d) => {
      const p = parseJson<Record<string, unknown>>(d.payload, {});
      return {
        id: d.id,
        conversation_id: d.conversation_id,
        version: d.version,
        updated_at: d.updated_at,
        contact_name: d.contact_name || String(p.to || "New conversation"),
        subject: d.subject || String(p.subject || "(No subject)"),
        preview: String(p.text || "").slice(0, 200),
        ai: !!p.ai_run_id,
      };
    }),
  );
});
aiRoutes.post("/ai/model-check", async (c) => {
  const { model } = z
    .object({
      model: z.string().refine((v) => AI_MODELS.some((m) => m.id === v)),
    })
    .strict()
    .parse(await c.req.json());
  const { getAgentByName } = await import("agents");
  const agent = await getAgentByName(c.env.SUPPORT_AGENT, "model-check");
  return c.json(await agent.checkModel(model));
});
