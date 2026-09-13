import { DomUtils, parseDocument } from "htmlparser2";

type Node = ReturnType<typeof parseDocument>["children"][number];
type Element = ReturnType<typeof DomUtils.getElementsByTagName>[number];
export type CustomerFact = { label: string; value: string; href?: string };
export type CustomerSite = {
  id: string;
  title: string;
  dashboardUrl?: string;
  url?: string;
  edition?: string;
  plan?: string;
  license?: string;
  facts: CustomerFact[];
  environment: CustomerFact[];
};
export type FreemiusCardData = {
  name: string;
  id: string;
  profileUrl: string;
  facts: CustomerFact[];
  sites: CustomerSite[];
  additional: CustomerFact[];
};
export const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];
export const label = (value: unknown) =>
  value === null || value === undefined
    ? "—"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      ["https:", "http:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Missing and relative provider links are not navigable. */
  }
}
export type BadgeTone =
  "positive" | "warning" | "negative" | "info" | "neutral";
export function badgeTone(value: string): BadgeTone {
  const text = value.trim().toLowerCase();
  if (
    /^(expired|inactive|cancelled|canceled|revoked|unsubscribed|cleaned|refunded|bounced)\b/.test(
      text,
    )
  )
    return "negative";
  if (
    /^(trial|pending|paused|past due|renewal cancelled|renewal canceled)\b/.test(
      text,
    )
  )
    return "warning";
  if (
    /^(active|subscribed|professional|pro plan|business|enterprise|paid)\b/.test(
      text,
    )
  )
    return "positive";
  if (/^premium\b/.test(text)) return "info";
  return "neutral";
}
const text = (node: Node) =>
  DomUtils.textContent(node).replace(/\s+/g, " ").trim();
const tags = (node: Node, name: string) =>
  DomUtils.getElementsByTagName(name, [node]);
function recordLink(node: Element, kind: "users" | "sites") {
  const href = safeLink(node.attribs.href);
  if (!href) return;
  const url = new URL(href);
  if (url.hostname !== "dashboard.freemius.com" || url.protocol !== "https:")
    return;
  const id = url.hash.match(new RegExp(`/${kind}/(\\d+)(?:/|$)`))?.[1];
  return id ? { href, id } : undefined;
}
function fact(node: Element): CustomerFact | null {
  const value = text(node);
  if (!value) return null;
  const link = tags(node, "a").find((a) => safeLink(a.attribs.href));
  const href = link && safeLink(link.attribs.href);
  if (href?.startsWith("mailto:"))
    return { label: "Billing email", value: text(link!), href };
  const match = value.match(/^([^:]{1,45}):\s*(.+)$/);
  if (match)
    return {
      label: match[1] === "LTV" ? "Lifetime value" : match[1],
      value: match[2],
      href,
    };
  return { label: "", value, href };
}
function listFact(node: Element): CustomerFact | null {
  const leaves = tags(node, "span").filter(
    (span) => !tags(span, "span").some((other) => other !== span),
  );
  const last = leaves.at(-1),
    value = last && text(last),
    full = text(node);
  if (value && full !== value && full.endsWith(value))
    return { label: full.slice(0, -value.length).trim(), value };
  return fact(node);
}
/** Read sanitized customer lookup HTML without trusting provider styles or scripts. */
export function freemiusCards(html: string): FreemiusCardData | null {
  const document = parseDocument(html);
  const profile = tags(document, "a").find((a) => recordLink(a, "users"));
  if (!profile) return null;
  const profileLink = recordLink(profile, "users")!;
  let profileHeading: Node | null = profile;
  while (
    profileHeading &&
    !(profileHeading.type === "tag" && profileHeading.name === "h4")
  )
    profileHeading = profileHeading.parent;
  const profileGroup = profileHeading?.parent;
  if (!profileGroup) return null;
  const used = new Set<Node>(tags(profileGroup, "h4"));
  const facts = tags(profileGroup, "h4")
    .filter((h) => h !== profileHeading)
    .map(fact)
    .filter((f): f is CustomerFact => !!f);
  const sites: CustomerSite[] = [];
  for (const heading of tags(document, "h4")) {
    const anchor = tags(heading, "a").find((a) => recordLink(a, "sites"));
    if (!anchor || !heading.parent) continue;
    const siteLink = recordLink(anchor, "sites")!;
    const group = heading.parent;
    const site: CustomerSite = {
      id: siteLink.id,
      title: text(anchor).replace(/\s*\(\d+\)$/, ""),
      dashboardUrl: siteLink.href,
      facts: [],
      environment: [],
    };
    const environmentRows = new Set<Node>();
    for (const h of tags(group, "h4")) {
      used.add(h);
      if (h === heading) continue;
      const value = text(h);
      if (/^(premium|free|trial) version$/i.test(value)) site.edition = value;
      else if (/\bplan$/i.test(value)) site.plan = value;
      else if (/^license:\s*/i.test(value))
        site.license = value.replace(/^license:\s*/i, "");
      else if (value === "Environment" && h.parent) {
        for (const li of tags(h.parent, "li")) {
          if (tags(li, "li").length > 1) continue;
          environmentRows.add(li);
          const entry = listFact(li);
          if (entry) site.environment.push(entry);
        }
      } else {
        const link = tags(h, "a").find((a) => {
          const href = safeLink(a.attribs.href);
          return (
            href &&
            !href.startsWith("mailto:") &&
            new URL(href).hostname !== "dashboard.freemius.com"
          );
        });
        if (link && !site.url) site.url = safeLink(link.attribs.href);
        else {
          const entry = fact(h);
          if (entry) site.facts.push(entry);
        }
      }
    }
    for (const li of tags(group, "li")) {
      if (
        environmentRows.has(li) ||
        tags(li, "li").length > 1 ||
        tags(li, "h4").length
      )
        continue;
      const entry = listFact(li);
      if (entry) site.facts.push(entry);
    }
    sites.push(site);
  }
  return {
    name: text(profile).replace(/\s+Profile\s*\(\d+\)$/i, ""),
    id: profileLink.id,
    profileUrl: profileLink.href,
    facts,
    sites,
    additional: tags(document, "h4")
      .filter((h) => !used.has(h))
      .map(fact)
      .filter((f): f is CustomerFact => !!f),
  };
}

export function licenseState(
  license: Record<string, unknown> | undefined,
  at = Date.now(),
): string | undefined {
  if (!license) return;
  if (license.is_cancelled === true) return "Inactive";
  let expires: number | undefined;
  if (license.expiration) {
    const raw = String(license.expiration).replace(" ", "T");
    expires = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + "Z");
    if (!Number.isFinite(expires)) return;
    if (expires <= at) return "Expired";
  }
  if (license.is_trial === true) return "Trial";
  if (license.expiration === null) return "Active (lifetime)";
  if (expires !== undefined) return "Active";
}
