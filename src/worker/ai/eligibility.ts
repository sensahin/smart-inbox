import type { Contact, Message, ProviderResult } from "../../shared/types";
import {
  freemiusCards,
  licenseState,
  records,
} from "../../shared/customer-data";
import { parseJson } from "../db";
export function automatedReason(
  message: Message,
  customer: Contact,
  support: string[],
): string | null {
  const h = parseJson<Record<string, string>>(message.headers, {});
  if (message.direction !== "inbound") return "No customer message to answer.";
  if (
    support.includes(customer.email.toLowerCase()) ||
    support.includes(message.sender.toLowerCase())
  )
    return "Connected support address.";
  if (
    /mailer-daemon|postmaster|no[._-]?reply|notifications?|alerts?@/i.test(
      message.sender + " " + customer.email,
    )
  )
    return "Automated sender.";
  if (
    h["list-id"] ||
    h["list-unsubscribe"] ||
    h["x-auto-response-suppress"] ||
    /bulk|list|junk/i.test(h.precedence || "") ||
    (h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no") ||
    /multipart\/report|delivery-status/i.test(h["content-type"] || "")
  )
    return "Automated, mailing-list, or delivery-status message.";
  return null;
}
export function paidEligibility(
  result: ProviderResult,
  email: string,
  at = Date.now(),
): string | null {
  if (result.state !== "matched")
    return result.state === "not_found"
      ? "No paid Freemius customer found."
      : "Freemius is unavailable or not configured. No model call made.";
  const paidPlan = (value: unknown) =>
    /^(professional|pro|business|enterprise|starter|agency|premium|paid)(\b|_)/i.test(
      String(value || "").trim(),
    );
  if (result.html) {
    const card = freemiusCards(result.html);
    if (
      !card ||
      !card.facts.some(
        (f) =>
          f.label === "Billing email" &&
          f.value.toLowerCase() === email.toLowerCase(),
      )
    )
      return "Freemius billing identity could not be verified.";
    return card.sites.some(
      (s) =>
        paidPlan(s.plan) &&
        /^active(?:\s*\(lifetime\))?$/i.test(s.license || ""),
    )
      ? null
      : "An active paid license could not be verified.";
  }
  const data = result.data || {},
    user = data.user as Record<string, unknown> | undefined;
  if (String(user?.email || "").toLowerCase() !== email.toLowerCase())
    return "Freemius billing identity could not be verified.";
  const plans = records(data.plans);
  return records(data.licenses).some(
    (l) =>
      l.is_trial === false &&
      /^Active/.test(licenseState(l, at) || "") &&
      plans.some(
        (p) =>
          String(p.id) === String(l.plan_id) &&
          (paidPlan(p.name) || paidPlan(p.title)),
      ),
  )
    ? null
    : "An active paid license could not be verified.";
}
export function redactReference(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(
      /\b(?:sk[-_]|pk[-_]|gh[pousr]_|github_pat_|cfut_)[A-Za-z0-9_:.-]{12,}/g,
      "[redacted key]",
    )
    .replace(
      /((?:api[_ -]?key|secret|password|access[_ -]?token|license[_ -]?key)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}
