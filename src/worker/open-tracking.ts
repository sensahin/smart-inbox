import type { AppEnv } from "./env";
import { one, setting } from "./db";
import { sha256 } from "./secrets";
import { publicHttpsUrl } from "../shared/workspace";
import { escapeHtml } from "./mail";

export function trackingOrigin(env: AppEnv): string {
  const value = env.OPEN_TRACKING_ORIGIN || "";
  if (!publicHttpsUrl(value)) return "";
  const url = new URL(value);
  return url.pathname === "/" && !url.search && url.origin !== env.APP_ORIGIN
    ? url.origin
    : "";
}

export async function prepareOpenTracking(
  env: AppEnv,
  outgoingId: string,
  at: number,
): Promise<D1PreparedStatement | null> {
  const origin = trackingOrigin(env);
  if (!origin || (await setting(env, "open_tracking_enabled")) !== "true")
    return null;
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");
  return env.DB.prepare(
    "INSERT OR IGNORE INTO message_opens(outgoing_id,token_hash,image_url,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM outgoing WHERE id=?)",
  ).bind(
    outgoingId,
    await sha256(token),
    `${origin}/o/${token}.gif`,
    at,
    outgoingId,
  );
}

export async function outgoingHtml(
  env: AppEnv,
  outgoingId: string,
  html: string,
) {
  if ((await setting(env, "open_tracking_enabled")) !== "true") return html;
  const receipt = await one<{ image_url: string }>(
    env.DB,
    "SELECT image_url FROM message_opens WHERE outgoing_id=?",
    outgoingId,
  );
  if (!receipt) return html;
  // Only the MIME sent through Gmail includes the pixel. The saved message
  // body and composer never load it as a side effect of viewing a ticket.
  return `${html}<img src="${escapeHtml(receipt.image_url)}" width="1" height="1" alt="" data-smart-inbox-open="1">`;
}
