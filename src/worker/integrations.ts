import type { AppEnv } from "./env";
import type { Contact, ProviderResult } from "../shared/types";
import { AppError, normalizeEmail, now, one, run, setting } from "./db";
import { secret } from "./secrets";
import { readJson } from "./google";
import { cleanHtml } from "./mail";
type RecordData = Record<string, unknown>;
const pick = (data: RecordData, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]),
  );
async function providerJson<T>(
  url: string,
  headers: Record<string, string>,
  options: RequestInit = {},
) {
  const res = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new AppError(
      502,
      res.status === 401 || res.status === 403
        ? "Provider credentials were rejected."
        : res.status === 429
          ? "Provider rate limit reached. Try again shortly."
          : `Provider returned HTTP ${res.status}.`,
    );
  }
  return readJson<T>(res, 2 * 1024 * 1024);
}
export function validateFreemiusCallback(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.freemius.com" ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/v1\/developers\/\d+\/(plugins|products)\/\d+\/[a-z][a-z0-9_-]*\.json$/.test(
      url.pathname,
    ) ||
    url.search ||
    url.hash
  )
    throw new AppError(400, "Use a product callback URL on api.freemius.com.");
  return url.href;
}
export function validateSignatureHeader(header: string) {
  if (!/^X-[A-Za-z0-9-]{1,60}$/i.test(header))
    throw new AppError(400, "Enter a valid X- signature header name.");
  return header;
}
export function entitlement(licenses: RecordData[], at = now()) {
  if (!licenses.length) return "Free";
  const active = licenses.filter((l) => {
    const raw = String(l.expiration || "").replace(" ", "T"),
      expires = raw
        ? Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + "Z")
        : Infinity;
    return l.is_cancelled !== true && expires > at;
  });
  if (active.some((l) => l.is_trial === true)) return "Trial";
  if (active.length) return "Active paid";
  return "Expired / inactive";
}
async function freemius(
  env: AppEnv,
  email: string,
): Promise<Omit<ProviderResult, "fetched_at">> {
  const mode = await setting(env, "freemius_mode", "api");
  if (mode === "callback") {
    const url = await setting(env, "freemius_callback_url"),
      key = await secret(env, "freemius_callback_secret"),
      signatureHeader = await setting(env, "freemius_signature_header");
    if (!url || !key || !signatureHeader) return { state: "unconfigured" };
    const body = JSON.stringify({
      customer: { id: 0, email, emails: [email], fname: "", lname: "" },
      ticket: { id: 0, number: 0, subject: "Customer lookup" },
      mailbox: { id: 0, email: "" },
    });
    const signingKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        signingKey,
        new TextEncoder().encode(body),
      ),
    ).toString("base64");
    const data = await providerJson<{ html?: string }>(
      validateFreemiusCallback(url),
      {
        "Content-Type": "application/json",
        [validateSignatureHeader(signatureHeader)]: signature,
      },
      { method: "POST", body },
    );
    if (typeof data.html !== "string")
      throw new AppError(
        502,
        "Freemius callback did not return sidebar content.",
      );
    const html = cleanHtml(data.html);
    return {
      state: /user (?:doesn['’]t|does not) exist/i.test(html)
        ? "not_found"
        : "matched",
      html,
    };
  }
  const token = await secret(env, "freemius_token");
  const productId = await setting(env, "freemius_product_id");
  if (!token || !/^\d+$/.test(productId)) return { state: "unconfigured" };
  const base = `https://api.freemius.com/v1/products/${productId}`;
  const headers = { Authorization: `Bearer ${token}` };
  const data = await providerJson<{ users: RecordData[] }>(
    `${base}/users.json?email=${encodeURIComponent(email)}&fields=id,email,first,last,created,gross&count=50`,
    headers,
  );
  if (!Array.isArray(data.users))
    throw new AppError(502, "Freemius customer response is incomplete.");
  const user = data.users.find(
    (u) => normalizeEmail(String(u.email)) === email,
  );
  if (!user) return { state: "not_found" };
  const userId = String(user.id);
  if (!/^\d+$/.test(userId))
    throw new AppError(
      502,
      "Freemius returned an invalid customer identifier.",
    );
  const fieldMap: Record<string, string> = {
    licenses:
      "id,plan_id,expiration,is_cancelled,is_trial,quota,activated,created",
    subscriptions:
      "id,plan_id,billing_cycle,is_active,canceled_at,next_payment,amount,currency,created",
    payments: "id,amount,currency,created,type,is_refunded",
    installs:
      "id,url,version,platform_version,php_version,is_active,license_id,created",
  };
  const collections: Record<string, RecordData[]> = {};
  for (const collection of [
    "licenses",
    "subscriptions",
    "payments",
    "installs",
  ]) {
    const records: RecordData[] = [];
    let offset = 0;
    for (;;) {
      const d = await providerJson<Record<string, RecordData[]>>(
        `${base}/users/${userId}/${collection}.json?count=50&offset=${offset}&fields=${fieldMap[collection]}`,
        headers,
      );
      const page = d[collection];
      if (!Array.isArray(page))
        throw new AppError(
          502,
          `Freemius ${collection} response is incomplete.`,
        );
      records.push(
        ...page.map((r) => pick(r, fieldMap[collection].split(","))),
      );
      if (page.length < 50) break;
      offset += 50;
      if (offset >= 1000) break;
    }
    collections[collection] = records;
  }
  const plans = await providerJson<{ plans: RecordData[] }>(
    `${base}/plans.json?fields=id,name,title&count=50`,
    headers,
  );
  return {
    state: "matched",
    data: {
      user,
      entitlement: entitlement(collections.licenses),
      ...collections,
      plans: plans.plans.map((p) => pick(p, ["id", "name", "title"])),
      profile_url: `https://dashboard.freemius.com/#!/live/products/${productId}/users/${userId}/`,
    },
  };
}
async function mailchimp(
  env: AppEnv,
  email: string,
): Promise<Omit<ProviderResult, "fetched_at">> {
  const key = await secret(env, "mailchimp_key");
  if (!key) return { state: "unconfigured" };
  const server = key.split("-").at(-1);
  if (!server || !/^us\d+$/.test(server))
    throw new AppError(
      400,
      "Mailchimp API key must include its server suffix.",
    );
  const base = `https://${server}.api.mailchimp.com/3.0`,
    headers = {
      Authorization: `Basic ${Buffer.from(`support:${key}`).toString("base64")}`,
    };
  const data = await providerJson<{
    exact_matches?: { members: RecordData[] };
    full_search?: { members: RecordData[] };
  }>(`${base}/search-members?query=${encodeURIComponent(email)}`, headers);
  if (
    !Array.isArray(data.exact_matches?.members) &&
    !Array.isArray(data.full_search?.members)
  )
    throw new AppError(502, "Mailchimp member response is incomplete.");
  const candidates = [
    ...(data.exact_matches?.members || []),
    ...(data.full_search?.members || []),
  ];
  const members = candidates
    .filter(
      (m, i, a) =>
        normalizeEmail(String(m.email_address)) === email &&
        a.findIndex((x) => x.id === m.id && x.list_id === m.list_id) === i,
    )
    .map((m) =>
      pick(m, [
        "id",
        "email_address",
        "status",
        "list_id",
        "list_name",
        "tags",
        "web_id",
        "contact_id",
        "last_changed",
      ]),
    );
  const audiences: RecordData[] = [];
  for (let offset = 0; ; offset += 100) {
    const lists = await providerJson<{
      lists: RecordData[];
      total_items: number;
    }>(
      `${base}/lists?fields=lists.id,lists.name,total_items&count=100&offset=${offset}`,
      headers,
    );
    if (
      !Array.isArray(lists.lists) ||
      !Number.isFinite(lists.total_items) ||
      (!lists.lists.length && audiences.length < lists.total_items)
    )
      throw new AppError(502, "Mailchimp audience response is incomplete.");
    audiences.push(...lists.lists);
    if (audiences.length >= lists.total_items) break;
  }
  return {
    state: members.length ? "matched" : "not_found",
    data: {
      members: members.map((m) => ({
        ...m,
        list_name:
          m.list_name || audiences.find((a) => a.id === m.list_id)?.name,
        profile_url: m.web_id
          ? `https://${server}.admin.mailchimp.com/lists/members/view?id=${Number(m.web_id)}`
          : null,
      })),
      audiences,
    },
  };
}
export async function customerIntegration(
  env: AppEnv,
  contact: Contact,
  provider: "freemius" | "mailchimp",
  refresh = false,
): Promise<ProviderResult> {
  const cached = await one<{ payload: string; fetched_at: number }>(
    env.DB,
    "SELECT * FROM integration_snapshots WHERE contact_id=? AND provider=?",
    contact.id,
    provider,
  );
  if (cached && !refresh && now() - cached.fetched_at < 300000)
    return JSON.parse(cached.payload) as ProviderResult;
  let result: ProviderResult;
  try {
    result = {
      ...(await (provider === "freemius"
        ? freemius(env, normalizeEmail(contact.freemius_email || contact.email))
        : mailchimp(env, normalizeEmail(contact.email)))),
      fetched_at: now(),
    };
  } catch (e) {
    result = {
      state: "error",
      fetched_at: now(),
      error:
        e instanceof AppError
          ? e.message
          : "Provider is temporarily unavailable. Try again.",
    };
  }
  await run(
    env.DB,
    "INSERT INTO integration_snapshots VALUES (?,?,?,?) ON CONFLICT(contact_id,provider) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
    contact.id,
    provider,
    JSON.stringify(result),
    result.fetched_at,
  );
  return result;
}
