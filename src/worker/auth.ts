import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
export const authentication: MiddlewareHandler<Bindings> = async (c, next) => {
  const url = new URL(c.req.url);
  const local =
    c.env.LOCAL_DEV_AUTH === "1" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (local) c.set("owner", c.env.OWNER_EMAIL || "local-owner@example.test");
  else {
    if (!c.env.OWNER_EMAIL || !c.env.ACCESS_AUD || !c.env.ACCESS_TEAM_DOMAIN)
      return c.json(
        {
          error:
            "Private deployment is awaiting Cloudflare Access configuration.",
        },
        503,
      );
    if (url.origin !== c.env.APP_ORIGIN)
      return c.json({ error: "This deployment URL is not authorized." }, 403);
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token)
      return c.json({ error: "Sign in through Cloudflare Access." }, 401);
    try {
      const issuer = `https://${c.env.ACCESS_TEAM_DOMAIN}`;
      const { payload } = await jwtVerify(
        token,
        createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
        { issuer, audience: c.env.ACCESS_AUD },
      );
      if (
        typeof payload.email !== "string" ||
        payload.email.toLowerCase() !== c.env.OWNER_EMAIL.toLowerCase()
      )
        return c.json({ error: "This account is not allowed." }, 403);
      c.set("owner", payload.email);
    } catch {
      return c.json({ error: "Your session has expired. Sign in again." }, 401);
    }
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin !== c.env.APP_ORIGIN)
      return c.json({ error: "Request origin is not authorized." }, 403);
    if (c.req.header("X-Support-Request") !== "1")
      return c.json({ error: "Missing request protection." }, 403);
  }
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  await next();
};
