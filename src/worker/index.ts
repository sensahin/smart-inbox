import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { AppEnv, Bindings, Job } from "./env";
import { authentication } from "./auth";
import { all, AppError, now, recordEvent } from "./db";
import { settingsRoutes } from "./routes/settings";
import { inboxRoutes } from "./routes/inboxes";
import { conversationRoutes } from "./routes/conversations";
import { contactRoutes } from "./routes/contacts";
import { pendingJobs, sendOutgoing } from "./outbox";
import { synchronize } from "./sync";
import { backup, maintenance } from "./backup";
import { aiRoutes } from "./ai/routes";
import { recoverDraftJobs } from "./ai/jobs";
import { syncDocumentation } from "./ai/knowledge";
const app = new Hono<Bindings>();
app.use("*", authentication);
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request exceeds 16 MB." }, 413),
  }),
);
app.get("/api/me", (c) =>
  c.json({ email: c.get("owner"), local: c.env.LOCAL_DEV_AUTH === "1" }),
);
app.route("/api", aiRoutes);
app.route("/api", settingsRoutes);
app.route("/api", inboxRoutes);
app.route("/api", conversationRoutes);
app.route("/api", contactRoutes);
app.all("/api/*", (c) => c.json({ error: "Endpoint not found." }, 404));
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  if (error instanceof ZodError)
    return c.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      400,
    );
  if (error instanceof AppError)
    return c.json(
      { error: error.message },
      error.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503,
    );
  console.error(
    JSON.stringify({
      event: "request_error",
      path: c.req.path,
      type: error.name,
    }),
  );
  return c.json(
    { error: "The request could not be completed. Please retry." },
    500,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: AppEnv) {
    if (controller.cron === "0 1 * * *") {
      await backup(env);
      await maintenance(env);
      return;
    }
    const mailboxes = await all<{ id: string }>(
      env.DB,
      "SELECT id FROM mailboxes WHERE state='connected' AND lease_until<?",
      now(),
    );
    for (const m of mailboxes)
      await env.JOBS.send({ type: "sync", mailboxId: m.id });
    for (const job of await pendingJobs(env))
      await env.JOBS.send({ type: "send", outgoingId: job.id });
    try {
      await recoverDraftJobs(env);
    } catch {
      await recordEvent(
        env,
        "ai_recovery_failed",
        null,
        "AI recovery failed; mailbox jobs were still scheduled.",
      );
    }
  },
  async queue(batch: MessageBatch<Job>, env: AppEnv) {
    for (const message of batch.messages) {
      try {
        const job = message.body;
        if (job.type === "sync") await synchronize(env, job.mailboxId);
        else if (job.type === "send") await sendOutgoing(env, job.outgoingId);
        else if (job.type === "ai-docs") await syncDocumentation(env);
        else if (job.type === "ai-draft") {
          const { getAgentByName } = await import("agents");
          const agent = await getAgentByName(
            env.SUPPORT_AGENT,
            job.conversationId,
          );
          await agent.generate(job.runId);
        } else await backup(env);
        message.ack();
      } catch {
        await recordEvent(
          env,
          "job_error",
          null,
          "Background processing failed; bounded queue retry scheduled.",
        );
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<AppEnv, Job>;
export { app };
