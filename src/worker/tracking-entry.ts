// This separate public Worker serves only an identical transparent image.
// Dashboard APIs, message bodies and attachments remain behind Access.
import { sha256 } from "./secrets";
import type { AppEnv } from "./env";
type TrackingEnv = Pick<AppEnv, "DB" | "APP_ORIGIN">;
const pixel = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

export default {
  async fetch(request: Request, env: TrackingEnv) {
    const url = new URL(request.url);
    const match = /^\/o\/([a-f0-9]{64})\.gif$/.exec(url.pathname);
    if (
      url.origin !== env.APP_ORIGIN ||
      !match ||
      !["GET", "HEAD"].includes(request.method)
    )
      return new Response("Not found", { status: 404 });
    if (request.method === "GET") {
      try {
        const at = Date.now();
        await env.DB.prepare(
          "UPDATE message_opens SET first_opened_at=? WHERE token_hash=? AND first_opened_at IS NULL AND created_at>? AND EXISTS(SELECT 1 FROM settings WHERE key='open_tracking_enabled' AND value='true')",
        )
          .bind(at, await sha256(match[1]), at - 90 * 86400000)
          .run();
      } catch {
        // Tracking is best effort. No request URLs, IPs, user agents or email
        // addresses are logged, and failures reveal no record information.
      }
    }
    return new Response(request.method === "HEAD" ? null : pixel, {
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "private, no-store, no-cache, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    });
  },
} satisfies ExportedHandler<TrackingEnv>;
