import { DEFAULT_WORKSPACE, type WorkspaceSettings } from "./workspace";
const replyPrefix = /^(?:(?:re|fw|fwd):\s*)+/i;
const categories =
  /^(?:\[\s*(?:Technical Support|Billing Issue|Feature Request|Customization|Pre-Sale Question|Press|Bug)\s*\])\s*/i;

/** Normalize only explicitly configured Freemius product envelopes; preserve customer-written text. */
export function supportSubject(
  subject: string,
  config: Pick<
    WorkspaceSettings,
    "product_name" | "subject_identifiers"
  > = DEFAULT_WORKSPACE,
): string {
  if (!config.product_name || !config.subject_identifiers.length)
    return subject;
  const prefix = subject.match(replyPrefix)?.[0] || "";
  const source = subject.slice(prefix.length);
  const match = source.match(
    /^\[Plugin:\s*([^\]]+)\s*\]\s*\[Plan:\s*([a-z0-9][a-z0-9 _-]{0,59})\s*\]\s*(.*)$/i,
  );
  if (
    !match ||
    !config.subject_identifiers.some(
      (id) => id.toLowerCase() === match[1].trim().toLowerCase(),
    )
  )
    return subject;
  const plan = match[2]
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const customerSubject = match[3].replace(categories, "").trim();
  return `${prefix}[${config.product_name} · ${plan}] — ${customerSubject || "Support request"}`;
}

export function sameEmailSubject(a: string, b: string): boolean {
  return (
    a.replace(replyPrefix, "").trim().toLowerCase() ===
    b.replace(replyPrefix, "").trim().toLowerCase()
  );
}
