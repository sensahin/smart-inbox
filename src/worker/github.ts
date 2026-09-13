import { z } from "zod";
import type { AppEnv } from "./env";
import { setting } from "./db";

export const githubRepoSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (v) =>
      !v ||
      (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) &&
        !v.split("/").some((p) => p === "." || p === "..")),
    "Use owner/repository.",
  );

export async function githubConnection(env: AppEnv) {
  const [repo, mode, token, revision] = await Promise.all([
    setting(env, "github_repo"),
    setting(env, "github_access", "public"),
    setting(env, "secret:github_token"),
    setting(env, "github_revision"),
  ]);
  const access =
    mode === "private" ? ("private" as const) : ("public" as const);
  return {
    repo,
    access,
    revision,
    configured: !!repo && (access === "public" || !!token),
  };
}
