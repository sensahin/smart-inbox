import { z } from "zod";
import {
  DEFAULT_WORKSPACE,
  publicHttpsUrl,
  type WorkspaceSettings,
} from "../shared/workspace";
import type { AppEnv } from "./env";
import { parseJson, setting } from "./db";

export const workspaceSchema = z
  .object({
    load_external_images: z.boolean().default(false),
    name: z.string().trim().min(1).max(60),
    logo: z
      .string()
      .max(140000)
      .refine(
        (v) =>
          !v || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v),
        "Upload a PNG, JPEG or WebP logo under 100 KB.",
      ),
    documentation_url: z
      .string()
      .trim()
      .max(500)
      .refine((v) => !v || publicHttpsUrl(v), "Use a public HTTPS URL."),
    product_name: z
      .string()
      .trim()
      .max(60)
      .refine((v) => !/[\[\]\r\n]/.test(v)),
    subject_identifiers: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((v) => !/[\[\]\r\n]/.test(v)),
      )
      .max(20),
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Enter a valid time zone."),
  })
  .strict();

export async function workspaceSettings(
  env: AppEnv,
): Promise<WorkspaceSettings> {
  return {
    ...DEFAULT_WORKSPACE,
    ...parseJson<Partial<WorkspaceSettings>>(
      await setting(env, "workspace"),
      {},
    ),
  };
}
