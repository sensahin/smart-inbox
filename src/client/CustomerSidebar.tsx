import { useState } from "react";
import {
  ChevronDown,
  Copy,
  CreditCard,
  ExternalLink,
  Link as LinkIcon,
  Mail,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import type { ProviderResult } from "../shared/types";
import type { Detail } from "./Conversation";
import { api, dateTime, initials, relative, useResource } from "./api";
import { FreemiusDetails } from "./FreemiusDetails";
import { CustomerBadge, CustomerLink } from "./CustomerCards";
import { ActionMenu } from "./ActionMenu";
import { label, records } from "../shared/customer-data";

export function CustomerSidebar({
  detail: d,
  refresh,
  select,
  openContact,
  reload,
  notify,
}: {
  detail: Detail;
  refresh: number;
  select: (id: string) => void;
  openContact: (id: string) => void;
  reload: () => void;
  notify: (s: string) => void;
}) {
  const [force, setForce] = useState(0),
    [linking, setLinking] = useState(false),
    [email, setEmail] = useState(d.contact.freemius_email || ""),
    [linkBusy, setLinkBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const fs = useResource<ProviderResult>(
    `/contacts/${d.contact.id}/integrations/freemius`,
    refresh + force,
  );
  const mc = useResource<ProviderResult>(
    `/contacts/${d.contact.id}/integrations/mailchimp`,
    refresh + force,
  );
  const f = fs.data,
    m = mc.data;
  async function refreshProviders() {
    setRefreshing(true);
    const results = await Promise.allSettled(
      ["freemius", "mailchimp"].map((provider) =>
        api(`/contacts/${d.contact.id}/integrations/${provider}?refresh=1`),
      ),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      notify(
        failed.reason instanceof Error
          ? failed.reason.message
          : "Customer details could not be refreshed.",
      );
    setForce((value) => value + 1);
    setRefreshing(false);
  }
  return (
    <aside
      id="customer-details"
      className="customer-sidebar"
      aria-label="Customer details"
    >
      <section className="customer-profile" aria-label="Customer profile">
        <span className="avatar hue-1" aria-hidden="true">
          {initials(d.contact.name)}
        </span>
        <ActionMenu
          label="Customer actions"
          items={[
            {
              label: "View full profile",
              icon: <ExternalLink size={16} />,
              onSelect: () => openContact(d.contact.id),
            },
            {
              label: "Copy email",
              icon: <Copy size={16} />,
              onSelect: () =>
                void navigator.clipboard
                  .writeText(d.contact.email)
                  .then(() => notify("Email copied."))
                  .catch(() => notify("Email could not be copied.")),
            },
            {
              label: refreshing ? "Refreshing…" : "Refresh details",
              icon: <RefreshCw size={16} />,
              disabled: refreshing,
              onSelect: () => void refreshProviders(),
            },
          ]}
        />
        <h3>{d.contact.name}</h3>
        <a className="customer-email" href={`mailto:${d.contact.email}`}>
          {d.contact.email}
        </a>
      </section>
      <div className="customer-cards">
        <section className="customer-section" aria-labelledby="history-heading">
          <div className="section-title">
            <h3 id="history-heading">Conversations</h3>
          </div>
          {!d.history.length ? (
            <p className="customer-note">
              This is the first conversation you’ve had with {d.contact.name}.
            </p>
          ) : (
            <div className="history-list">
              {d.history.slice(0, 6).map((c) => (
                <button
                  onClick={() => select(c.id)}
                  key={c.id}
                  title={c.subject}
                >
                  <span className="history-icon" aria-hidden="true">
                    <Mail size={16} />
                  </span>
                  <span className="history-subject">{c.subject}</span>
                </button>
              ))}
              {d.history.length > 6 && (
                <button
                  className="history-more"
                  onClick={() => openContact(d.contact.id)}
                >
                  <span className="history-icon" aria-hidden="true">
                    <MoreHorizontal size={16} />
                  </span>
                  View all conversations
                </button>
              )}
            </div>
          )}
        </section>
        <section
          className="customer-section"
          aria-labelledby="freemius-heading"
        >
          <div className="section-title">
            <h3 id="freemius-heading">
              <CreditCard size={16} /> Freemius
            </h3>
          </div>
          <ProviderState
            result={f}
            error={fs.error}
            loading={fs.loading}
            empty="User doesn’t exist."
          />
          {f?.state === "matched" && !fs.error && (
            <FreemiusDetails
              key={`${d.contact.id}:${d.contact.freemius_email || d.contact.email}`}
              result={f}
            />
          )}
          <div className="provider-footer">
            <button
              className="text-button link-customer"
              aria-expanded={linking}
              onClick={() => setLinking(!linking)}
            >
              <LinkIcon size={13} />
              {d.contact.freemius_email
                ? "Change billing email"
                : "Link a different billing email"}
            </button>
            {d.contact.freemius_email && (
              <span className="linked-email">{d.contact.freemius_email}</span>
            )}
            {linking && (
              <form
                className="link-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setLinkBusy(true);
                  void api(`/contacts/${d.contact.id}/freemius-link`, {
                    method: "PUT",
                    body: JSON.stringify({ email: email.trim() || null }),
                  })
                    .then(() => {
                      notify("Freemius customer link updated.");
                      setLinking(false);
                      setForce((v) => v + 1);
                      reload();
                    })
                    .catch((e) => notify(e.message))
                    .finally(() => setLinkBusy(false));
                }}
              >
                <label>
                  Billing email
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="customer@example.com"
                  />
                </label>
                <div className="link-form-actions">
                  <button className="button small-button" disabled={linkBusy}>
                    {linkBusy ? "Looking up…" : "Find & link"}
                  </button>
                  {d.contact.freemius_email && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={linkBusy}
                      onClick={() => {
                        setLinkBusy(true);
                        void api(`/contacts/${d.contact.id}/freemius-link`, {
                          method: "PUT",
                          body: JSON.stringify({ email: null }),
                        })
                          .then(() => {
                            setEmail("");
                            setLinking(false);
                            reload();
                            setForce((v) => v + 1);
                            notify("Using the contact email for Freemius.");
                          })
                          .catch((e) => notify(e.message))
                          .finally(() => setLinkBusy(false));
                      }}
                    >
                      Remove link
                    </button>
                  )}
                </div>
              </form>
            )}
            <Updated result={f} refreshing={refreshing} />
          </div>
        </section>
        <section
          className="customer-section"
          aria-labelledby="mailchimp-heading"
        >
          <div className="section-title">
            <h3 id="mailchimp-heading">
              <Mail size={16} /> Mailchimp
            </h3>
          </div>
          <ProviderState
            result={m}
            error={mc.error}
            loading={mc.loading}
            empty="Customer not on any lists."
          />
          {m?.state === "matched" &&
            !mc.error &&
            records(m.data?.members).map((member) => (
              <div
                className="membership"
                key={`${member.list_id}:${member.id}`}
              >
                <CustomerBadge>{label(member.status)}</CustomerBadge>
                <strong>{label(member.list_name || member.list_id)}</strong>
                {!!records(member.tags).length && (
                  <div className="member-tags">
                    {records(member.tags).map((tag) => (
                      <CustomerBadge key={label(tag.id)} tone="neutral">
                        {label(tag.name)}
                      </CustomerBadge>
                    ))}
                  </div>
                )}
                {typeof member.profile_url === "string" && (
                  <CustomerLink href={member.profile_url}>
                    View Mailchimp profile
                  </CustomerLink>
                )}
              </div>
            ))}
          {m?.state === "not_found" &&
            !mc.error &&
            records(m.data?.audiences).length > 0 && (
              <details className="available-audiences">
                <summary>
                  Available audiences{" "}
                  <span className="count-badge">
                    {records(m.data?.audiences).length}
                  </span>
                  <ChevronDown size={14} />
                </summary>
                {records(m.data?.audiences).map((a) => (
                  <p key={label(a.id)}>{label(a.name)}</p>
                ))}
                <CustomerLink href="https://admin.mailchimp.com/">
                  Open Mailchimp
                </CustomerLink>
              </details>
            )}
          <Updated result={m} refreshing={refreshing} />
        </section>
      </div>
    </aside>
  );
}
function Updated({
  result,
  refreshing,
}: {
  result: ProviderResult | null;
  refreshing: boolean;
}) {
  return result ? (
    <p className="provider-updated" title={dateTime(result.fetched_at)}>
      {refreshing ? "Refreshing…" : `Updated ${relative(result.fetched_at)}`}
    </p>
  ) : null;
}
function ProviderState({
  result,
  error,
  loading,
  empty,
}: {
  result: ProviderResult | null;
  error: string;
  loading: boolean;
  empty: string;
}) {
  if (error || result?.state === "error")
    return (
      <p className="provider-error" role="alert">
        {error || result?.error || "Integration unavailable."}
      </p>
    );
  if (!result && loading)
    return (
      <p className="customer-note" role="status">
        Loading customer details…
      </p>
    );
  if (result?.state === "unconfigured")
    return (
      <p className="customer-note">Connect this integration in Settings.</p>
    );
  if (result?.state === "not_found")
    return <p className="customer-note">{empty}</p>;
  return null;
}
