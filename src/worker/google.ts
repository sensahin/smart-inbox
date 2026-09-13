import { addressParser, decodeWords, type Email } from "postal-mime";
import type { AppEnv } from "./env";
import type { Mailbox } from "../shared/types";
import { AppError, normalizeEmail, one, parseJson, run, setting } from "./db";
import { decrypt, secret } from "./secrets";
export interface ConnectedMailbox extends Mailbox {
  refresh_token: string;
}
export function verifiedSendingAddress(
  mailbox: Pick<Mailbox, "email" | "aliases">,
  address: string,
) {
  const normalized = normalizeEmail(address);
  // Gmail only supplies verificationStatus for custom aliases, not the primary account.
  return (
    normalized === normalizeEmail(mailbox.email) ||
    parseJson<{ sendAsEmail: string; verificationStatus?: string }[]>(
      mailbox.aliases,
      [],
    ).some(
      (alias) =>
        normalizeEmail(alias.sendAsEmail) === normalized &&
        alias.verificationStatus === "accepted",
    )
  );
}
export class GoogleError extends AppError {
  constructor(
    status: number,
    public reason: string,
  ) {
    super(status, reason);
  }
}
export async function googleCredentials(env: AppEnv) {
  return {
    clientId: await setting(env, "google_client_id"),
    clientSecret: await secret(env, "google_client_secret"),
  };
}
export async function readJson<T>(
  res: Response,
  max = 8 * 1024 * 1024,
): Promise<T> {
  if (!res.body)
    throw new AppError(502, "Provider returned an empty response.");
  const reader = res.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max)
        throw new AppError(
          502,
          "Provider response exceeds the application limit.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const joined = new Uint8Array(total);
  let pos = 0;
  for (const x of chunks) {
    joined.set(x, pos);
    pos += x.length;
  }
  return JSON.parse(new TextDecoder().decode(joined)) as T;
}
export async function exchangeCode(
  env: AppEnv,
  code: string,
  verifier: string,
) {
  const credentials = await googleCredentials(env);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: `${env.APP_ORIGIN}/api/google/callback`,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok)
    throw new AppError(
      400,
      "Google authorization failed. Reconnect and grant the requested permissions.",
    );
  return readJson<{
    access_token: string;
    refresh_token?: string;
    scope: string;
  }>(res);
}
export async function accessToken(env: AppEnv, mailbox: ConnectedMailbox) {
  const credentials = await googleCredentials(env);
  if (!credentials.clientId || !credentials.clientSecret)
    throw new AppError(503, "Configure the Google OAuth client in Settings.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: await decrypt(env, mailbox.refresh_token),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401)
      await run(
        env.DB,
        "UPDATE mailboxes SET state='disconnected',error='Google authorization expired. Reconnect this mailbox.' WHERE id=?",
        mailbox.id,
      );
    throw new GoogleError(res.status, "Google token refresh failed.");
  }
  return (await readJson<{ access_token: string }>(res)).access_token;
}
export async function gmail<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(25000),
    },
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new GoogleError(
      res.status,
      res.status === 404
        ? "Gmail resource not found."
        : res.status === 429
          ? "Google rate limit reached."
          : "Google could not complete the request.",
    );
  }
  return readJson<T>(res, 40 * 1024 * 1024);
}
export async function getMailbox(env: AppEnv, id: string) {
  const m = await one<ConnectedMailbox>(
    env.DB,
    "SELECT * FROM mailboxes WHERE id=?",
    id,
  );
  if (!m) throw new AppError(404, "Mailbox not found.");
  return m;
}
export interface GmailPart {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  snippet?: string;
  payload: GmailPart;
}
export async function decodeMessage(
  token: string,
  message: GmailMessage,
  beforePart = async () => {},
): Promise<Email> {
  const headers = (message.payload.headers || []).map((h) => ({
    key: h.name.toLowerCase(),
    originalKey: h.name,
    value: h.value,
  }));
  const h = Object.fromEntries(headers.map((h) => [h.key, h.value]));
  const parsed: Email = {
    headers,
    headerLines: [],
    from: addressParser(h.from || "")[0],
    to: addressParser(h.to || ""),
    cc: addressParser(h.cc || ""),
    replyTo: addressParser(h["reply-to"] || ""),
    subject: decodeWords(h.subject || "(No subject)"),
    messageId: h["message-id"],
    inReplyTo: h["in-reply-to"],
    references: h.references,
    date: h.date,
    deliveredTo: h["delivered-to"],
    returnPath: h["return-path"],
    text: "",
    html: "",
    attachments: [],
  };
  async function part(p: GmailPart) {
    await beforePart();
    if (p.parts) {
      for (const child of p.parts) await part(child);
      return;
    }
    const ph = Object.fromEntries(
      (p.headers || []).map((x) => [x.name.toLowerCase(), x.value]),
    );
    const attachment =
      !!p.filename ||
      /attachment|inline/.test(ph["content-disposition"] || "") ||
      !["text/plain", "text/html"].includes(p.mimeType);
    if ((p.body?.size || 0) > 24 * 1024 * 1024) {
      parsed.text += `\n[Attachment “${p.filename || "attachment"}” exceeds the 24 MB processing limit. Open the original message in Gmail: https://mail.google.com/mail/u/?authuser=${encodeURIComponent(h["delivered-to"] || "")}&view=att&th=${message.threadId}]\n`;
      return;
    }
    let data = p.body?.data || "";
    if (p.body?.attachmentId)
      data = (
        await gmail<{ data: string }>(
          token,
          `messages/${message.id}/attachments/${encodeURIComponent(p.body.attachmentId)}`,
        )
      ).data;
    const bytes = Buffer.from(data, "base64url");
    if (attachment)
      parsed.attachments.push({
        filename: p.filename || "attachment",
        mimeType: p.mimeType,
        disposition: ph["content-id"] ? "inline" : "attachment",
        contentId: ph["content-id"],
        content: bytes,
      });
    else if (p.mimeType === "text/html") parsed.html += bytes.toString("utf8");
    else parsed.text += bytes.toString("utf8");
  }
  await part(message.payload);
  return parsed;
}
