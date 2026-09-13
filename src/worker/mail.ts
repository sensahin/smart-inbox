import sanitize from "sanitize-html";
import { addressParser, type Address, type Email } from "postal-mime";
import type { ComposePayload, Inbox } from "../shared/types";
import { AppError, normalizeEmail } from "./db";
import { publicHttpsUrl } from "../shared/workspace";
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const textToHtml = (value: string) =>
  `<div>${escapeHtml(value).replace(/\n/g, "<br>")}</div>`;
const cssColor = /^(?:#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i;
const cssLength = /^(?:0|\d{1,4}(?:\.\d+)?(?:px|pt|em|rem|%)|auto)$/i;
const cssSpacing =
  /^(?:0|\d{1,3}(?:\.\d+)?(?:px|pt|em|rem|%)|auto)(?:\s+(?:0|\d{1,3}(?:\.\d+)?(?:px|pt|em|rem|%)|auto)){0,3}$/i;
const emailStyles = {
  color: [cssColor],
  "background-color": [cssColor],
  background: [cssColor],
  "font-family": [/^[a-z\d\s,'"-]+$/i],
  "font-size": [/^\d{1,2}(?:\.\d+)?(?:px|pt|em|rem|%)$/i],
  "font-weight": [/^(?:normal|bold|bolder|lighter|[1-9]00)$/],
  "font-style": [/^(?:normal|italic|oblique)$/],
  "line-height": [/^(?:normal|\d{1,3}(?:\.\d+)?(?:px|pt|em|rem|%)?)$/],
  "text-align": [/^(?:left|right|center|justify|start|end|inherit)$/],
  "text-decoration": [/^(?:none|underline|line-through)$/],
  "vertical-align": [/^(?:top|middle|bottom|baseline|text-top|text-bottom)$/],
  "border-collapse": [/^(?:collapse|separate)$/],
  "border-spacing": [cssSpacing],
  border: [
    /^(?:0|none|\d{1,2}px (?:solid|dashed|dotted) (?:#[\da-f]{3,8}|[a-z]+))$/i,
  ],
  "border-radius": [cssSpacing],
  width: [cssLength],
  "max-width": [cssLength],
  height: [cssLength],
  "max-height": [cssLength],
  display: [/^(?:none|block|inline|inline-block|table|table-row|table-cell)$/],
  visibility: [/^(?:hidden|visible)$/],
  overflow: [/^(?:hidden|auto)$/],
  "box-sizing": [/^(?:border-box|content-box)$/],
  ...Object.fromEntries(
    ["margin", "padding"].flatMap((property) =>
      ["", "-top", "-right", "-bottom", "-left"].map((side) => [
        property + side,
        [cssSpacing],
      ]),
    ),
  ),
};
export function cleanHtml(
  html: string,
  images: Record<string, string> = {},
  outgoing = false,
  remoteImages = false,
) {
  return sanitize(html, {
    allowedTags: [
      "p",
      "div",
      "span",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "a",
      "ul",
      "ol",
      "li",
      "table",
      "tbody",
      "thead",
      "tr",
      "td",
      "th",
      "h1",
      "h2",
      "h3",
      "h4",
      "hr",
      "img",
      "center",
      "font",
      "caption",
      "tfoot",
    ],
    nonTextTags: ["script", "style", "textarea", "option", "title", "head"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: [
        "src",
        "alt",
        "width",
        "height",
        "referrerpolicy",
        "data-remote-image",
      ],
      table: [
        "width",
        "cellpadding",
        "cellspacing",
        "border",
        "align",
        "bgcolor",
      ],
      td: [
        "colspan",
        "rowspan",
        "width",
        "height",
        "align",
        "valign",
        "bgcolor",
      ],
      th: [
        "colspan",
        "rowspan",
        "width",
        "height",
        "align",
        "valign",
        "bgcolor",
      ],
      font: ["color", "face", "size"],
      span: ["class", "data-remote-image", "title"],
      "*": ["dir", "style"],
    },
    allowedClasses: { span: ["email-image-placeholder"] },
    allowedStyles: { "*": emailStyles },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: {
      img: outgoing ? ["cid"] : remoteImages ? ["data", "https"] : ["data"],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: (_, attr) => ({
        tagName: "a",
        attribs: { ...attr, target: "_blank", rel: "noopener noreferrer" },
      }),
      img: (_, attr): sanitize.Tag => {
        // Tracking pixels and invisible spacers add no readable content. Never
        // load our own sent pixel when the owner opens a Gmail-synced reply.
        if (
          attr["data-smart-inbox-open"] === "1" ||
          (attr.width &&
            attr.height &&
            Number(attr.width) <= 2 &&
            Number(attr.height) <= 2)
        )
          return { tagName: "span", attribs: {}, text: "" };
        const cid = attr.src?.replace(/^cid:/i, "").replace(/[<>]/g, "");
        const inline = Object.hasOwn(images, cid) ? images[cid] : undefined;
        const remote = publicHttpsUrl(attr.src || "");
        const src =
          inline || (!outgoing && remoteImages && remote ? attr.src : "");
        if (src)
          return {
            tagName: "img",
            attribs: {
              ...attr,
              src,
              alt: attr.alt || "",
              referrerpolicy: "no-referrer",
              ...(remote ? { "data-remote-image": "true" } : {}),
            },
          };
        return {
          tagName: "span",
          attribs: {
            class: "email-image-placeholder",
            title: remote ? "Remote image blocked" : "Image unavailable",
            ...(remote ? { "data-remote-image": "true" } : {}),
          },
          text: attr.alt || "",
        };
      },
    },
  });
}
export function emailCsp(remoteImages = false) {
  return `default-src 'none'; img-src data:${remoteImages ? " https:" : ""}; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`;
}
export function emailDocument(html: string, remoteImages = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${emailCsp(remoteImages)}"><style>body{font:15px/1.6 "Helvetica Neue",Arial,sans-serif;color:#293530;margin:0;overflow-wrap:anywhere}.email-content{display:flow-root;max-width:720px;margin:0 auto}img{max-width:100%!important;height:auto;vertical-align:middle}p{margin:0 0 1em}p:last-child{margin-bottom:0}h1{font-size:26px;line-height:1.3}h2{font-size:22px;line-height:1.35}h3{font-size:18px;line-height:1.4}pre{white-space:pre-wrap;background:#f4f6f5;padding:16px;border-radius:6px;font-size:0.9em}blockquote{border-left:2px solid #dbe3df;margin-left:0;padding-left:14px;color:#57675f}a{color:#11644d;text-decoration:underline;text-underline-offset:2px}table{max-width:100%!important;min-width:0!important}th{text-align:left;font-weight:normal}.email-image-placeholder{display:inline-block;font-size:12px;line-height:1.4;color:#78847e}.email-image-placeholder:empty{display:none}</style></head><body><div class="email-content">${html}</div></body></html>`;
}
export const addresses = (values: Address[] | undefined) =>
  (values || [])
    .flatMap((x) =>
      x.address ? [x.address] : (x.group || []).map((a) => a.address),
    )
    .map(normalizeEmail);
export function parseAddresses(value: string) {
  return addresses(addressParser(value));
}
export function customerIdentity(
  mail: Email,
  supportAddresses: string[],
  sent = false,
) {
  const support = new Set(supportAddresses.map(normalizeEmail));
  const identity = (address: Address | undefined) => {
    if (!address?.address) return;
    const email = normalizeEmail(address.address);
    if (!email || support.has(email)) return;
    return {
      email,
      name: address.name?.trim().replace(/\s+/g, " ") || email,
    };
  };
  const flatten = (values: Address[] | undefined) =>
    (values || []).flatMap((value) => value.group || [value]);
  if (sent)
    return flatten(mail.to)
      .map(identity)
      .find((value) => value !== undefined);

  // Relays such as contact forms put their own identity in From. Keep the
  // customer's name paired with the single Reply-To address, not the relay.
  const replyTo = flatten(mail.replyTo);
  if (replyTo.length === 1) {
    const customer = identity(replyTo[0]);
    if (customer) {
      const sender = identity(mail.from);
      if (customer.name === customer.email && sender?.email === customer.email)
        customer.name = sender.name;
      return customer;
    }
  }
  return identity(mail.from);
}
export function template(text: string, vars: Record<string, string>) {
  return text.replace(
    /\{\{([\w.]+)(?:\|([^}]*))?\}\}/g,
    (_, key: string, fallback: string) => vars[key]?.trim() || fallback || "",
  );
}
export function outsideOfficeHours(
  date: Date,
  inbox: Pick<Inbox, "timezone" | "office_start" | "office_end">,
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: inbox.timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const day = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return (
    day === "Sat" ||
    day === "Sun" ||
    hour < inbox.office_start ||
    hour >= inbox.office_end
  );
}
export function shouldAcknowledge(
  email: Email,
  inbox: Inbox,
  supportAddresses: string[],
  at: Date,
) {
  const headers = Object.fromEntries(
    email.headers.map((h) => [h.key, h.value]),
  );
  const from = email.from?.address?.toLowerCase() || "";
  if (
    inbox.auto_reply_mode === "off" ||
    !from ||
    supportAddresses.includes(from) ||
    addresses(email.replyTo).some((address) =>
      supportAddresses.includes(address),
    ) ||
    headers["list-id"] ||
    headers["list-unsubscribe"] ||
    headers["x-auto-response-suppress"] ||
    /bulk|list|junk/i.test(headers.precedence || "") ||
    /mailer-daemon|postmaster|no-?reply/i.test(from)
  )
    return false;
  if (
    headers["auto-submitted"] &&
    headers["auto-submitted"].toLowerCase() !== "no"
  )
    return false;
  if (/multipart\/report|delivery-status/i.test(headers["content-type"] || ""))
    return false;
  return inbox.auto_reply_mode === "always" || outsideOfficeHours(at, inbox);
}
const encoded = (value: string) =>
  `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
const lines = (data: Uint8Array | string) =>
  Buffer.from(data)
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") || "";
export interface MimeAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
  contentId?: string;
}
export function buildMime(
  payload: ComposePayload,
  fromName: string,
  from: string,
  messageId: string,
  reply: { id?: string; references?: string },
  attachments: MimeAttachment[],
  auto = false,
) {
  for (const s of [
    ...payload.to,
    ...payload.cc,
    ...payload.bcc,
    from,
    messageId,
    reply.id || "",
    reply.references || "",
  ])
    if (/[\r\n]/.test(s)) throw new AppError(400, "Invalid email header.");
  const mixed = `mixed_${crypto.randomUUID()}`,
    alt = `alt_${crypto.randomUUID()}`;
  const headers = [
    `From: ${encoded(fromName)} <${from}>`,
    `To: ${payload.to.join(", ")}`,
    payload.cc.length ? `Cc: ${payload.cc.join(", ")}` : "",
    payload.bcc.length ? `Bcc: ${payload.bcc.join(", ")}` : "",
    `Subject: ${encoded(payload.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    reply.id ? `In-Reply-To: ${reply.id}` : "",
    reply.id
      ? `References: ${[reply.references, reply.id].filter(Boolean).join(" ").slice(-8000)}`
      : "",
    auto ? "Auto-Submitted: auto-replied" : "",
    auto ? "X-Auto-Response-Suppress: All" : "",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ].filter(Boolean);
  let body = `--${mixed}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(payload.text)}\r\n--${alt}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(payload.html)}\r\n--${alt}--\r\n`;
  for (const a of attachments) {
    const filename = encodeURIComponent(a.filename).replace(/'/g, "%27");
    body += `--${mixed}\r\nContent-Type: ${a.contentType.replace(/[\r\n]/g, "")}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: ${a.contentId ? "inline" : "attachment"}; filename*=UTF-8''${filename}\r\n${a.contentId ? `Content-ID: <${a.contentId.replace(/[\r\n<>]/g, "")}>\r\n` : ""}\r\n${lines(a.data)}\r\n`;
  }
  const raw = `${headers.join("\r\n")}\r\n\r\n${body}--${mixed}--\r\n`;
  if (Buffer.byteLength(raw) > 34 * 1024 * 1024)
    throw new AppError(
      400,
      "The encoded email exceeds the 34 MB application limit. Remove an attachment.",
    );
  return Buffer.from(raw).toString("base64url");
}
