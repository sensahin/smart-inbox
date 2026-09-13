import { publicHttpsUrl } from "../../shared/workspace";
import { z } from "zod";
import { AI_MODELS, DEFAULT_AI, type AIConfig } from "../../shared/ai";
import type { AppEnv } from "../env";
import { parseJson, setting } from "../db";
export const configSchema = z
  .object({
    enabled: z.boolean(),
    model: z
      .string()
      .refine(
        (v) => AI_MODELS.some((m) => m.id === v),
        "Choose a supported Workers AI model.",
      ),
    instructions: z.string().max(8000),
    daily_limit: z.number().int().min(1).max(100),
    max_steps: z.number().int().min(1).max(5),
    use_history: z.boolean(),
    use_github: z.boolean(),
    documentation_index_url: z
      .string()
      .trim()
      .max(500)
      .refine(
        (v) =>
          !v ||
          (publicHttpsUrl(v) &&
            /\.(txt|md)$/.test(new URL(v).pathname) &&
            !new URL(v).search),
        "Use a public HTTPS llms.txt or Markdown index URL.",
      ),
    eligibility: z.enum(["paid_freemius", "all_customers"]),
  })
  .strict();
export async function aiConfig(env: AppEnv): Promise<AIConfig> {
  const stored = parseJson<Partial<AIConfig>>(
    await setting(env, "ai_config"),
    {},
  );
  return {
    ...configSchema
      .strip()
      .parse({
        ...DEFAULT_AI,
        ...stored,
        enabled:
          stored.enabled === true &&
          (await setting(env, "ai_paused")) !== "true",
      }),
    revision: stored.revision || "",
    enabled_at: stored.enabled_at || 0,
  };
}
