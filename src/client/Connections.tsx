import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Mail, Plus, Save, Upload, X } from "lucide-react";
import type { Health } from "../shared/types";
import { api, dateTime, useResource } from "./api";

const providers = [
  {
    id: "google",
    name: "Google Workspace",
    mark: "G",
    description: "Receive and send support email.",
  },
  {
    id: "freemius",
    name: "Freemius",
    mark: "f",
    description: "Customer plans, licenses, and sites.",
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    mark: "m",
    description: "Audience membership and subscriptions.",
  },
  {
    id: "github",
    name: "GitHub",
    mark: "GH",
    description: "Repository access for code references.",
  },
] as const;
type Provider = (typeof providers)[number]["id"];
const providerKeys: Record<Provider, string[]> = {
  google: ["google_client_id", "google_client_secret"],
  freemius: [
    "freemius_mode",
    "freemius_callback_url",
    "freemius_signature_header",
    "freemius_callback_secret",
    "freemius_token",
    "freemius_product_id",
  ],
  mailchimp: ["mailchimp_key"],
  github: ["github_repo", "github_access", "github_token"],
};
export function Connections({
  health,
  reload,
  notify,
  refresh,
}: {
  health: Health | null;
  reload: () => void;
  notify: (message: string) => void;
  refresh: number;
}) {
  const config = useResource<Record<string, string | boolean>>(
    "/settings",
    refresh,
  );
  const [selected, setSelected] = useState<Provider | null>(null);
  // Keep only pending edits here; refreshed settings must not overwrite them.
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef<Partial<Record<Provider, HTMLButtonElement | null>>>(
    {},
  );
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected]);
  const base = (key: string) =>
    String(
      config.data?.[key] ??
        (key === "freemius_mode"
          ? "api"
          : key === "github_access"
            ? "public"
            : ""),
    );
  const value = (key: string) => values[key] ?? base(key);
  const update = (key: string, next: string) =>
    setValues((v) => {
      const values = { ...v, [key]: next };
      if (key === "github_access" && next === "public")
        delete values.github_token;
      return values;
    });
  const dirty = (provider: Provider) =>
    providerKeys[provider].some(
      (key) => values[key] !== undefined && values[key] !== base(key),
    );
  const ready = !!config.data && !config.error;
  const canSave =
    ready &&
    !busy &&
    (!!config.data?.encryption_configured ||
      (selected === "github" && value("github_access") === "public"));
  const googleConfigured =
    !!base("google_client_id") &&
    !!config.data?.google_client_secret_configured;
  const mailboxes = health?.mailboxes || [];
  const googleIssue = mailboxes.some((m) => m.error || m.state !== "connected");
  const freemiusConfigured =
    base("freemius_mode") === "api"
      ? !!config.data?.freemius_token_configured &&
        !!base("freemius_product_id")
      : !!base("freemius_callback_url") &&
        !!base("freemius_signature_header") &&
        !!config.data?.freemius_callback_secret_configured;
  const saved = {
    google: mailboxes.some((m) => m.state === "connected"),
    freemius: freemiusConfigured,
    mailchimp: !!config.data?.mailchimp_key_configured,
    github:
      !!base("github_repo") &&
      (base("github_access") === "public" ||
        !!config.data?.github_token_configured),
  };
  const active = providers.find((p) => p.id === selected);
  const close = () => {
    if (selected) buttons.current[selected]?.focus();
    setSelected(null);
    setSaveError("");
  };
  async function persist(provider: Provider) {
    const body = Object.fromEntries(
      providerKeys[provider]
        .filter((key) => values[key] !== undefined && values[key] !== base(key))
        .map((key) => [key, values[key]]),
    );
    if (!Object.keys(body).length) return;
    await api("/settings", { method: "PUT", body: JSON.stringify(body) });
    setValues((v) => {
      const next = { ...v };
      for (const key of providerKeys[provider]) delete next[key];
      return next;
    });
    reload();
  }
  async function save(provider: Provider, connect = false) {
    setBusy(true);
    setSaveError("");
    try {
      await persist(provider);
      if (connect) {
        const result = await api<{ url: string }>("/google/connect", {
          method: "POST",
          body: "{}",
        });
        location.assign(result.url);
      } else
        notify(
          `${providers.find((p) => p.id === provider)!.name} settings saved.`,
        );
    } catch (e) {
      setSaveError((e as Error).message);
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mailboxAction(id: string, action: "sync" | "disconnect") {
    setBusy(true);
    setSaveError("");
    try {
      await api(`/mailboxes/${id}/${action}`, { method: "POST", body: "{}" });
      notify(
        action === "sync" ? "Mailbox check queued." : "Mailbox disconnected.",
      );
      reload();
    } catch (e) {
      setSaveError((e as Error).message);
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function githubAction(disconnect = false) {
    setBusy(true);
    setSaveError("");
    try {
      if (!disconnect) await persist("github");
      await api(disconnect ? "/settings/github" : "/settings/github/check", {
        method: disconnect ? "DELETE" : "POST",
      });
      if (disconnect)
        setValues((v) =>
          Object.fromEntries(
            Object.entries(v).filter(
              ([key]) => !providerKeys.github.includes(key),
            ),
          ),
        );
      reload();
      notify(
        disconnect
          ? "GitHub disconnected."
          : "GitHub repository access verified.",
      );
    } catch (e) {
      setSaveError((e as Error).message);
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (
    key: string,
    title: string,
    secret = false,
    placeholder = "",
  ) => (
    <label className="field" key={key}>
      <span>
        {title}
        {secret && config.data?.[`${key}_configured`] && (
          <small className="configured">
            <Check size={11} /> Saved
          </small>
        )}
      </span>
      <input
        type={secret ? "password" : "text"}
        autoComplete="off"
        disabled={busy}
        value={value(key)}
        onChange={(e) => update(key, e.target.value)}
        placeholder={
          secret && config.data?.[`${key}_configured`]
            ? "Leave blank to keep saved credential"
            : placeholder
        }
      />
    </label>
  );
  return (
    <div className="settings-stack connections-page">
      {config.error && (
        <div className="notice danger" role="alert">
          {config.error}
        </div>
      )}
      {config.data && !config.data.encryption_configured && (
        <div className="notice danger" role="alert">
          The server encryption key must be configured before credentials can be
          saved.
        </div>
      )}
      <div className="connection-grid">
        {providers.map((provider) => {
          const issue = provider.id === "google" && googleIssue;
          const unavailable = !ready || (provider.id === "google" && !health);
          const status = unavailable
            ? config.error
              ? "Unavailable"
              : "Loading…"
            : issue
              ? "Needs attention"
              : saved[provider.id]
                ? provider.id === "google"
                  ? "Connected"
                  : "Configured"
                : "Not connected";
          return (
            <section
              className={`connection-card ${selected === provider.id ? "selected" : ""}`}
              key={provider.id}
              aria-labelledby={`${provider.id}-title`}
            >
              <div className="connection-card-top">
                <div
                  className={`connection-logo ${provider.id}-logo`}
                  aria-hidden="true"
                >
                  {provider.mark}
                </div>
                <span
                  className={`connection-badge ${!unavailable && !issue && saved[provider.id] ? "connected" : ""} ${issue ? "attention" : ""}`}
                >
                  {status}
                </span>
              </div>
              <h2 id={`${provider.id}-title`}>{provider.name}</h2>
              <p>{provider.description}</p>
              <div className="connection-card-detail">
                {provider.id === "google"
                  ? mailboxes.length
                    ? mailboxes.map((m) => m.email).join(", ")
                    : "Google Workspace mailbox"
                  : "Read-only access"}
              </div>
              <div className="connection-card-actions">
                <span>{dirty(provider.id) ? "Unsaved changes" : ""}</span>
                <button
                  className="button"
                  aria-label={`Manage ${provider.name}`}
                  aria-expanded={selected === provider.id}
                  aria-controls={
                    selected === provider.id
                      ? `${provider.id}-settings`
                      : undefined
                  }
                  disabled={!ready || busy}
                  ref={(element) => {
                    buttons.current[provider.id] = element;
                  }}
                  onClick={() => {
                    if (selected === provider.id) close();
                    else {
                      setSelected(provider.id);
                      setSaveError("");
                    }
                  }}
                >
                  Manage{" "}
                  <ChevronDown
                    size={14}
                    className={selected === provider.id ? "expanded" : ""}
                  />
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {active && (
        <section
          id={`${active.id}-settings`}
          className="settings-card connection-panel"
          aria-labelledby="connection-panel-title"
        >
          <header>
            <h2 id="connection-panel-title" tabIndex={-1} ref={heading}>
              {active.name}
            </h2>
            <button
              className="icon-button"
              aria-label={`Close ${active.name} settings`}
              disabled={busy}
              onClick={close}
            >
              <X size={18} />
            </button>
          </header>
          <div className="card-body">
            {selected === "google" && (
              <>
                {mailboxes.map((m) => (
                  <div className="connected-mailbox" key={m.id}>
                    <Mail size={17} />
                    <div>
                      <strong>{m.email}</strong>
                      <small>
                        {m.error || `New mail from ${dateTime(m.cutover_at)}`}
                      </small>
                    </div>
                    <span
                      className={`connection-badge ${m.state === "connected" && !m.error ? "connected" : ""}`}
                    >
                      {m.error ? "Needs attention" : m.state}
                    </span>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void mailboxAction(m.id, "sync")}
                    >
                      Sync
                    </button>
                    {m.state === "connected" && (
                      <button
                        className="text-button danger-text"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              `Disconnect ${m.email}? Tickets will be retained, but syncing and sending will stop.`,
                            )
                          )
                            void mailboxAction(m.id, "disconnect");
                        }}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                ))}
                <details
                  className="connection-advanced"
                  open={!googleConfigured}
                >
                  <summary>OAuth setup</summary>
                  <div className="field-grid">
                    {field("google_client_id", "OAuth client ID")}
                    {field("google_client_secret", "OAuth client secret", true)}
                  </div>
                  <label className="file-import">
                    <Upload size={14} /> Import Google client JSON
                    <input
                      type="file"
                      accept="application/json,.json"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file)
                          void file
                            .text()
                            .then((raw) => {
                              const data = JSON.parse(raw);
                              if (
                                typeof data.web?.client_id !== "string" ||
                                typeof data.web?.client_secret !== "string" ||
                                !data.web.client_id ||
                                !data.web.client_secret
                              )
                                throw new Error(
                                  "Choose the Google Web application credentials JSON.",
                                );
                              setValues((v) => ({
                                ...v,
                                google_client_id: data.web.client_id,
                                google_client_secret: data.web.client_secret,
                              }));
                              notify(
                                "Credentials loaded. Save Google Workspace to apply them.",
                              );
                            })
                            .catch((e) => notify(e.message));
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <div className="redirect-info">
                    <span>Authorized redirect URI</span>
                    <code>{config.data?.redirect_uri}</code>
                  </div>
                  <p className="field-help">
                    Use an Internal OAuth app from your Workspace organization
                    with Gmail read-only and send permissions.
                  </p>
                </details>
                <button
                  className="button"
                  disabled={
                    !canSave ||
                    !value("google_client_id") ||
                    !(
                      value("google_client_secret") ||
                      config.data?.google_client_secret_configured
                    )
                  }
                  onClick={() => void save("google", true)}
                >
                  <Plus size={15} /> Connect Google mailbox
                </button>
              </>
            )}
            {selected === "freemius" && (
              <>
                <label className="field">
                  <span>Connection method</span>
                  <select
                    value={value("freemius_mode")}
                    disabled={busy}
                    onChange={(e) => update("freemius_mode", e.target.value)}
                  >
                    <option value="callback">Signed customer lookup</option>
                    <option value="api">Freemius product API token</option>
                  </select>
                </label>
                {value("freemius_mode") === "api" ? (
                  <>
                    {field("freemius_product_id", "Product ID")}
                    {field("freemius_token", "Product API bearer token", true)}
                    <p className="field-help">
                      Freemius → Your product → Settings → API & Keys.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="field-grid">
                      {field("freemius_callback_url", "Callback URL")}
                      {field("freemius_callback_secret", "Secret key", true)}
                    </div>
                    {field(
                      "freemius_signature_header",
                      "Signature header",
                      false,
                      "X-Customer-Signature",
                    )}
                    <p className="field-help">
                      Use the endpoint, secret, and signature header required by
                      your customer lookup integration. Requests use HMAC-SHA1
                      with a base64 signature.
                    </p>
                  </>
                )}
              </>
            )}
            {selected === "mailchimp" && (
              <>
                {field(
                  "mailchimp_key",
                  "API key",
                  true,
                  "Your Mailchimp key, including the -us… suffix",
                )}
                <p className="field-help">
                  Mailchimp → Account & billing → Extras → API keys.
                  Subscription changes stay in Mailchimp.
                </p>
              </>
            )}
            {selected === "github" && (
              <>
                {field(
                  "github_repo",
                  "Repository (owner/name)",
                  false,
                  "owner/repository",
                )}
                <label className="field">
                  <span>Repository visibility</span>
                  <select
                    value={value("github_access")}
                    disabled={busy}
                    onChange={(e) => update("github_access", e.target.value)}
                  >
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </label>
                {value("github_access") === "private" ? (
                  <>
                    {field(
                      "github_token",
                      "Fine-grained GitHub token",
                      true,
                      "Read-only token",
                    )}
                    <p className="field-help">
                      Limit the token to this repository with Contents:
                      Read-only and Metadata: Read-only. It is encrypted on the
                      server.
                    </p>
                  </>
                ) : (
                  <p className="field-help">
                    Public repositories do not need a token.
                  </p>
                )}
                <p className="field-help">
                  Enable “Use GitHub as a reference” in AI settings when you
                  want the agent to use this repository.
                </p>
                <div className="ai-actions">
                  <button
                    className="button"
                    disabled={
                      !canSave ||
                      !value("github_repo") ||
                      (value("github_access") === "private" &&
                        !(
                          value("github_token") ||
                          config.data?.github_token_configured
                        ))
                    }
                    onClick={() => void githubAction()}
                  >
                    Test repository access
                  </button>
                  {saved.github && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void githubAction(true)}
                    >
                      Disconnect GitHub
                    </button>
                  )}
                </div>
                {config.data?.github_checked && !dirty("github") && (
                  <p className="field-help">Repository access verified.</p>
                )}
              </>
            )}
            {saveError && (
              <div className="notice danger" role="alert">
                {saveError}
              </div>
            )}
          </div>
          <footer className="connection-panel-footer">
            <span>Credentials are stored encrypted.</span>
            <button
              className="button primary"
              disabled={!canSave || !dirty(active.id)}
              onClick={() => void save(active.id)}
            >
              <Save size={15} /> {busy ? "Saving…" : `Save ${active.name}`}
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
