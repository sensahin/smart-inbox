import { generateText, isStepCount, Output } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, now, run, setSetting } from "../db";
import { replySchema } from "./reply";
export async function verifyModel(env: AppEnv, name: string) {
  const day = new Date().toISOString().slice(0, 10);
  const claimed = await run(
    env.DB,
    "INSERT INTO settings(key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(settings.value AS INTEGER)+1 WHERE CAST(settings.value AS INTEGER)<5",
    "ai_model_checks:" + day,
  );
  if (!claimed.meta.changes)
    throw new AppError(429, "The five daily model checks have been used.");
  const model = createWorkersAI({ binding: env.AI })(
    name as Parameters<ReturnType<typeof createWorkersAI>>[0],
  );
  let lookups = 0;
  try {
    const result = await generateText({
      model,
      prompt:
        "Call searchDocumentation for chatbot name settings, then explain exactly what the reference says. Do not guess the answer.",
      tools: {
        searchDocumentation: {
          description: "Find product documentation.",
          inputSchema: z.object({ query: z.string() }),
          execute: async () => {
            lookups++;
            return {
              id: "docs-chatbots",
              text: "To change the chatbot name, open Chatbot settings > Display > Chat text.",
            };
          },
        },
      },
      stopWhen: isStepCount(2),
      maxOutputTokens: 1400,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(120000),
    });
    if (!lookups) throw new Error("No reference tool call.");
    const final = await generateText({
      model,
      prompt:
        "Prepare a short support email to Alex explaining this reference. Return the greeting as its own paragraph, then separate paragraphs for the guidance. Do not add a signature: " +
        result.text,
      output: Output.object({
        schema: replySchema,
      }),
      maxOutputTokens: 2200,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(120000),
    });
    const proof = {
      ok: true,
      model: name,
      at: now(),
      lookups,
      reply: final.output.reply_paragraphs.join("\n\n"),
      input_tokens:
        (result.totalUsage.inputTokens || 0) +
        (final.totalUsage.inputTokens || 0),
      output_tokens:
        (result.totalUsage.outputTokens || 0) +
        (final.totalUsage.outputTokens || 0),
    };
    await setSetting(env, "ai_model_check", JSON.stringify(proof));
    return proof;
  } catch (e) {
    const result = {
      ok: false,
      model: name,
      at: now(),
      error: `Model check failed (${e instanceof Error ? e.name : "unknown error"}). Check Workers AI availability or select another model.`,
    };
    await setSetting(env, "ai_model_check", JSON.stringify(result));
    return result;
  }
}
