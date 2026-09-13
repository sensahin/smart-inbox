import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  badgeTone,
  safeLink,
  type BadgeTone,
  type CustomerFact,
} from "../shared/customer-data";

export function CustomerBadge({
  children,
  tone,
}: {
  children: string;
  tone?: BadgeTone;
}) {
  return (
    <span className={`customer-badge ${tone || badgeTone(children)}`}>
      {children}
    </span>
  );
}
export function CustomerLink({
  href,
  children,
  className = "",
}: {
  href: unknown;
  children: ReactNode;
  className?: string;
}) {
  const safe = safeLink(href);
  return safe ? (
    <a
      className={`customer-link ${className}`}
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function CustomerFacts({ values }: { values: CustomerFact[] }) {
  if (!values.length) return null;
  return (
    <dl className="customer-facts">
      {values.map((entry, index) => (
        <div key={`${entry.label}:${index}`}>
          {entry.label && <dt>{entry.label}</dt>}
          <dd className={!entry.label ? "full-fact" : undefined}>
            {entry.href ? (
              <CustomerLink href={entry.href}>{entry.value}</CustomerLink>
            ) : (
              entry.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
