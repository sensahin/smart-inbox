import { useMemo, useState } from "react";
import { ChevronDown, Globe, Monitor, Search, UserRound } from "lucide-react";
import type { ProviderResult } from "../shared/types";
import {
  badgeTone,
  freemiusCards,
  label,
  licenseState,
  records,
  type CustomerFact,
  type CustomerSite,
} from "../shared/customer-data";
import { CustomerBadge, CustomerFacts, CustomerLink } from "./CustomerCards";

export function FreemiusDetails({ result }: { result: ProviderResult }) {
  const cards = useMemo(
    () => (result.html ? freemiusCards(result.html) : null),
    [result.html],
  );
  if (cards)
    return (
      <>
        <div className="provider-profile">
          <UserRound size={17} aria-hidden="true" />
          <div>
            <CustomerLink href={cards.profileUrl}>{cards.name}</CustomerLink>
            <small>Customer #{cards.id}</small>
          </div>
        </div>
        <CustomerFacts values={cards.facts} />
        <SiteCollection sites={cards.sites} />
        {!!cards.additional.length && (
          <details className="provider-records">
            <summary>
              More details
              <ChevronDown size={14} />
            </summary>
            <CustomerFacts values={cards.additional} />
          </details>
        )}
      </>
    );
  if (result.data) return <StructuredFreemius data={result.data} />;
  // Unknown callback layouts retain their sanitized contents instead of guessing entitlement.
  if (result.html)
    return (
      <iframe
        title="Freemius customer details"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="provider-fallback"
        srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{font:13px/1.6 Helvetica,Arial,sans-serif;color:#33443b;margin:0;overflow-wrap:anywhere}h4{font-size:13px;font-weight:500;margin:8px 0}a{color:#176a54}ul{padding-left:16px}</style>${result.html}`}
      />
    );
  return null;
}
function SiteCollection({ sites }: { sites: CustomerSite[] }) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  if (!sites.length) return null;
  const filtered = sites.filter((site) =>
    `${site.title} ${site.url || ""} ${site.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const visible = query || showAll ? filtered : filtered.slice(0, 3);
  return (
    <div className="site-collection">
      <div className="subsection-title">
        <span>Sites</span>
        <span className="count-badge">{sites.length}</span>
      </div>
      {sites.length > 5 && (
        <label className="site-search">
          <Search size={14} />
          <input
            aria-label="Find a customer site"
            placeholder="Find a site…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div className="site-list">
        {visible.map((site) => (
          <SiteCard key={site.id} site={site} />
        ))}
      </div>
      {!filtered.length && <p className="customer-note">No matching sites.</p>}
      {!query && sites.length > 3 && (
        <button
          className="show-more"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show fewer sites" : `Show all ${sites.length} sites`}
        </button>
      )}
    </div>
  );
}
function SiteCard({ site }: { site: CustomerSite }) {
  const address = site.url?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <details className="site-card">
      <summary>
        <div className="site-heading">
          <Globe size={15} aria-hidden="true" />
          <span>{site.title}</span>
          <ChevronDown
            size={15}
            className="disclosure-chevron"
            aria-hidden="true"
          />
        </div>
        {address && address !== site.title && (
          <span className="site-address">{address}</span>
        )}
        <span className="badge-row">
          {site.plan && (
            <CustomerBadge tone="neutral">
              {site.plan.replace(/\s+plan$/i, "")}
            </CustomerBadge>
          )}
          {site.license && <CustomerBadge>{site.license}</CustomerBadge>}
          {site.edition &&
            site.edition.replace(/\s+version$/i, "").toLowerCase() !==
              site.plan?.replace(/\s+plan$/i, "").toLowerCase() && (
              <CustomerBadge>
                {site.edition.replace(/\s+version$/i, "")}
              </CustomerBadge>
            )}
        </span>
      </summary>
      <div className="site-details">
        <div className="site-links">
          <CustomerLink href={site.dashboardUrl}>Site #{site.id}</CustomerLink>
          {site.url && <CustomerLink href={site.url}>Visit site</CustomerLink>}
        </div>
        <CustomerFacts values={site.facts} />
        {!!site.environment.length && (
          <div className="site-environment">
            <h4>
              <Monitor size={14} /> Environment
            </h4>
            <CustomerFacts values={site.environment} />
          </div>
        )}
      </div>
    </details>
  );
}
function date(value: unknown) {
  if (!value) return "—";
  const raw = String(value);
  const at = new Date(
    raw.includes("T")
      ? raw
      : raw.replace(" ", "T") + (raw.includes(" ") ? "Z" : ""),
  );
  return Number.isNaN(at.getTime())
    ? raw
    : new Intl.DateTimeFormat("en-GB", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(at);
}
function StructuredFreemius({ data }: { data: Record<string, unknown> }) {
  const user = (data.user || {}) as Record<string, unknown>;
  const licenses = records(data.licenses),
    plans = records(data.plans);
  const planName = (id: unknown) => {
    const plan = plans.find((p) => String(p.id) === String(id));
    return plan
      ? label(plan.title || plan.name)
      : id
        ? `Plan #${id}`
        : undefined;
  };
  const sites = records(data.installs).map((install): CustomerSite => {
    const license = licenses.find(
      (item) => String(item.id) === String(install.license_id),
    );
    const url = typeof install.url === "string" ? install.url : undefined;
    return {
      id: label(install.id),
      title:
        url?.replace(/^https?:\/\//, "").replace(/\/$/, "") ||
        `Site #${install.id}`,
      url,
      plan: planName(license?.plan_id),
      license: licenseState(license),
      facts: [
        {
          label: "Activation",
          value:
            install.is_active === true
              ? "Active"
              : install.is_active === false
                ? "Inactive"
                : "—",
        },
      ],
      environment: [
        ["Plugin version", install.version],
        ["WordPress", install.platform_version],
        ["PHP", install.php_version],
      ]
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ label: String(key), value: label(value) })),
    };
  });
  return (
    <>
      <div className="provider-profile">
        <UserRound size={17} />
        <div>
          <CustomerLink href={data.profile_url}>
            {[user.first, user.last].filter(Boolean).join(" ") ||
              "Freemius profile"}
          </CustomerLink>
          <small>Customer #{label(user.id)}</small>
        </div>
      </div>
      {typeof data.entitlement === "string" && (
        <div className="badge-row">
          <CustomerBadge>{data.entitlement}</CustomerBadge>
        </div>
      )}
      <CustomerFacts
        values={[
          { label: "Registered", value: date(user.created) },
          ...(user.email
            ? [{ label: "Billing email", value: label(user.email) }]
            : []),
          ...(user.gross !== undefined
            ? [{ label: "Lifetime value", value: label(user.gross) }]
            : []),
        ]}
      />
      <RecordCollection
        title="Licenses"
        values={licenses}
        heading={(v) => planName(v.plan_id) || `License #${v.id}`}
        badge={licenseState}
        fields={(v) => [
          { label: "License ID", value: label(v.id) },
          {
            label: "Expires",
            value: v.expiration === null ? "Lifetime" : date(v.expiration),
          },
          { label: "Site allowance", value: label(v.quota) },
          { label: "Activations", value: label(v.activated) },
        ]}
      />
      <RecordCollection
        title="Subscriptions"
        values={records(data.subscriptions)}
        heading={(v) => planName(v.plan_id) || `Subscription #${v.id}`}
        badge={(v) =>
          v.canceled_at
            ? "Renewal cancelled"
            : v.is_active === true
              ? "Active"
              : v.is_active === false
                ? "Inactive"
                : undefined
        }
        fields={(v) => [
          { label: "Billing cycle", value: label(v.billing_cycle) },
          { label: "Amount", value: `${label(v.amount)} ${label(v.currency)}` },
          { label: "Next payment", value: date(v.next_payment) },
          ...(v.canceled_at
            ? [{ label: "Cancelled", value: date(v.canceled_at) }]
            : []),
        ]}
      />
      <SiteCollection sites={sites} />
      <RecordCollection
        title="Payments"
        values={records(data.payments)}
        heading={(v) => `${label(v.amount)} ${label(v.currency)}`}
        badge={(v) => (v.is_refunded === true ? "Refunded" : undefined)}
        fields={(v) => [
          { label: "Date", value: date(v.created) },
          { label: "Payment ID", value: label(v.id) },
        ]}
      />
    </>
  );
}
function RecordCollection({
  title,
  values,
  heading,
  badge,
  fields,
}: {
  title: string;
  values: Record<string, unknown>[];
  heading: (v: Record<string, unknown>) => string;
  badge: (v: Record<string, unknown>) => string | undefined;
  fields: (v: Record<string, unknown>) => CustomerFact[];
}) {
  if (!values.length) return null;
  return (
    <details className="provider-records">
      <summary>
        <span>
          {title} <span className="count-badge">{values.length}</span>
        </span>
        <ChevronDown size={14} />
      </summary>
      {values.map((value, i) => {
        const state = badge(value);
        return (
          <div className="provider-record" key={label(value.id || i)}>
            <div className="record-heading">
              <strong>{heading(value)}</strong>
              {state && (
                <CustomerBadge tone={badgeTone(state)}>{state}</CustomerBadge>
              )}
            </div>
            <CustomerFacts values={fields(value)} />
          </div>
        );
      })}
    </details>
  );
}
