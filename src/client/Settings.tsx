import { GeneralSettings } from "./GeneralSettings";
import type { WorkspaceSettings } from "../shared/workspace";
import { AISettings } from "./AISettings";
import { Connections } from "./Connections";
import { useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_ACK,
  type Health,
  type Inbox,
  type SavedReply,
} from "../shared/types";
import { api, dateTime, useResource } from "./api";
type SettingsProps = {
  workspace: WorkspaceSettings;
  inboxes: Inbox[];
  health: Health | null;
  refresh: number;
  reload: () => void;
  notify: (s: string) => void;
};
export function Settings(props: SettingsProps) {
  const [tab, setTab] = useState("connections");
  return (
    <section className="settings-page">
      <div className="settings-heading">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <nav className="settings-tabs">
        {[
          ["general", "General"],
          ["connections", "Connections"],
          ["inboxes", "Inboxes"],
          ["replies", "Saved replies"],
          ["ai", "AI"],
          ["operations", "Activity & sending"],
        ].map(([id, label]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === "general" ? (
          <GeneralSettings
            workspace={props.workspace}
            reload={props.reload}
            notify={props.notify}
          />
        ) : tab === "connections" ? (
          <Connections {...props} />
        ) : tab === "inboxes" ? (
          <InboxSettings {...props} />
        ) : tab === "replies" ? (
          <SavedReplies {...props} />
        ) : tab === "ai" ? (
          <AISettings notify={props.notify} />
        ) : (
          <Operations {...props} />
        )}
      </div>
    </section>
  );
}
function InboxSettings(props: SettingsProps) {
  const [id, setId] = useState(props.inboxes[0]?.id || "new");
  return (
    <div className="inbox-settings-layout">
      <div className="inbox-selector">
        {props.inboxes.map((i) => (
          <button
            className={id === i.id ? "active" : ""}
            key={i.id}
            onClick={() => setId(i.id)}
          >
            <Mail size={16} />
            <span>
              {i.name}
              <small>{i.address}</small>
            </span>
            <ChevronRight size={13} />
          </button>
        ))}
        <button onClick={() => setId("new")}>
          <Plus size={16} /> New inbox
        </button>
      </div>
      <InboxForm key={id} {...props} id={id} select={setId} />
    </div>
  );
}
function InboxForm({
  id,
  select,
  inboxes,
  workspace,
  health,
  reload,
  notify,
}: { id: string; select: (s: string) => void } & SettingsProps) {
  const existing = inboxes.find((i) => i.id === id);
  const [form, setForm] = useState<Omit<Inbox, "id" | "created_at">>(
    existing || {
      mailbox_id: null,
      name: workspace.name,
      address: "",
      from_name: workspace.name,
      signature: "",
      signature_aliases: 1,
      default_status: "closed",
      auto_bcc: "",
      auto_reply: DEFAULT_ACK,
      auto_reply_mode: "always",
      timezone: workspace.timezone,
      office_start: 9,
      office_end: 17,
      routing_priority: 100,
    },
  );
  const [busy, setBusy] = useState(false);
  const patch = (key: string, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save() {
    setBusy(true);
    try {
      const { id: result } = await api<{ id: string }>(`/inboxes/${id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      reload();
      select(result);
      notify("Inbox settings saved.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-stack">
      <section className="settings-card">
        <header>
          <div>
            <h2>{existing ? "Inbox settings" : "Create inbox"}</h2>
            <p>Sending identity and default conversation behavior.</p>
          </div>
        </header>
        <div className="card-body">
          <div className="field-grid">
            <label className="field">
              <span>Inbox name</span>
              <input
                value={form.name}
                onChange={(e) => patch("name", e.target.value)}
              />
            </label>
            <label className="field">
              <span>Inbox address</span>
              <input
                type="email"
                value={form.address}
                onChange={(e) => patch("address", e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Connected Google mailbox</span>
            <select
              value={form.mailbox_id || ""}
              onChange={(e) => patch("mailbox_id", e.target.value || null)}
            >
              <option value="">Connect later</option>
              {health?.mailboxes.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.email}
                </option>
              ))}
            </select>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>From name</span>
              <input
                value={form.from_name}
                onChange={(e) => patch("from_name", e.target.value)}
              />
            </label>
            <label className="field">
              <span>Status after reply</span>
              <select
                value={form.default_status}
                onChange={(e) => patch("default_status", e.target.value)}
              >
                <option value="closed">Closed</option>
                <option value="waiting">Waiting</option>
                <option value="open">Open</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Auto BCC</span>
            <input
              value={form.auto_bcc}
              placeholder="Optional email addresses, separated by commas"
              onChange={(e) => patch("auto_bcc", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Routing priority</span>
            <input
              type="number"
              min="0"
              value={form.routing_priority}
              onChange={(e) =>
                patch("routing_priority", Number(e.target.value))
              }
            />
            <small>
              If multiple addresses match, the lowest priority number receives
              the ticket.
            </small>
          </label>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <div>
            <h2>Signature</h2>
            <p>Appended to your outgoing replies.</p>
          </div>
        </header>
        <div className="card-body">
          <textarea
            aria-label="Inbox signature"
            rows={4}
            value={form.signature}
            placeholder="Your name and contact details"
            onChange={(e) => patch("signature", e.target.value)}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!form.signature_aliases}
              onChange={(e) =>
                patch("signature_aliases", e.target.checked ? 1 : 0)
              }
            />{" "}
            Use signature with aliases
          </label>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <div>
            <h2>Automatic acknowledgement</h2>
            <p>Sent once when a customer starts a new conversation.</p>
          </div>
        </header>
        <div className="card-body">
          <label className="field">
            <span>When to send</span>
            <select
              value={form.auto_reply_mode}
              onChange={(e) => patch("auto_reply_mode", e.target.value)}
            >
              <option value="always">Every new conversation</option>
              <option value="outside_hours">Outside office hours only</option>
              <option value="off">Disabled</option>
            </select>
          </label>
          <textarea
            aria-label="Automatic acknowledgement message"
            rows={12}
            value={form.auto_reply}
            onChange={(e) => patch("auto_reply", e.target.value)}
          />
          <p className="field-help">
            Variables: {"{{customer.firstName|there}}"},{" "}
            {"{{customer.fullName}}"}, {"{{customer.email}}"},{" "}
            {"{{inbox.name}}"}, {"{{ticket.number}}"}. Auto replies include only
            this message, without the inbox signature.
          </p>
          <div className="field-grid hours-grid">
            <label className="field">
              <span>Time zone</span>
              <input
                value={form.timezone}
                onChange={(e) => patch("timezone", e.target.value)}
              />
            </label>
            <label className="field">
              <span>Start hour</span>
              <input
                type="number"
                min="0"
                max="23"
                value={form.office_start}
                onChange={(e) => patch("office_start", Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>End hour</span>
              <input
                type="number"
                min="1"
                max="24"
                value={form.office_end}
                onChange={(e) => patch("office_end", Number(e.target.value))}
              />
            </label>
          </div>
          <p className="field-help">
            Office days: Monday–Friday. Global acknowledgements remain paused
            until enabled in Activity & sending.
          </p>
        </div>
      </section>
      <div className="settings-save">
        <span />
        <button
          className="button primary"
          onClick={() => void save()}
          disabled={busy}
        >
          <Save size={15} />
          {busy ? "Saving…" : "Save inbox"}
        </button>
      </div>
    </div>
  );
}
function SavedReplies({ refresh, reload, notify }: SettingsProps) {
  const replies = useResource<SavedReply[]>("/saved-replies", refresh);
  const [selected, setSelected] = useState<SavedReply | null>(null);
  const [title, setTitle] = useState(""),
    [body, setBody] = useState("");
  async function save() {
    try {
      await api(`/saved-replies/${selected?.id || "new"}`, {
        method: "PUT",
        body: JSON.stringify({ title, body }),
      });
      setSelected(null);
      setTitle("");
      setBody("");
      reload();
      notify("Saved reply updated.");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <div className="saved-replies-layout">
      <section className="settings-card">
        <header>
          <div>
            <h2>Your saved replies</h2>
            <p>Reusable answers you can edit before sending.</p>
          </div>
        </header>
        <div className="saved-reply-list">
          {!replies.data?.length && (
            <p className="muted">No saved replies yet.</p>
          )}
          {replies.data?.map((r) => (
            <div key={r.id}>
              <button
                onClick={() => {
                  setSelected(r);
                  setTitle(r.title);
                  setBody(r.body);
                }}
              >
                <strong>{r.title}</strong>
                <span>{r.body.slice(0, 90)}</span>
              </button>
              <button
                className="icon-button danger-text"
                title="Delete saved reply"
                onClick={() => {
                  if (confirm(`Delete “${r.title}”?`))
                    void api(`/saved-replies/${r.id}`, { method: "DELETE" })
                      .then(reload)
                      .catch((e) => notify(e.message));
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>{selected ? "Edit saved reply" : "New saved reply"}</h2>
          {selected && (
            <button
              className="text-button"
              onClick={() => {
                setSelected(null);
                setTitle("");
                setBody("");
              }}
            >
              New reply
            </button>
          )}
        </header>
        <div className="card-body">
          <label className="field">
            <span>Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Request diagnostic information"
            />
          </label>
          <label className="field">
            <span>Reply</span>
            <textarea
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <p className="field-help">
            Use {"{{customer.firstName|there}}"} for a personalized greeting.
          </p>
          <button
            className="button primary"
            disabled={!title.trim() || !body.trim()}
            onClick={() => void save()}
          >
            <Save size={15} /> Save reply
          </button>
        </div>
      </section>
    </div>
  );
}
function Operations({ health, reload, notify, refresh }: SettingsProps) {
  const events = useResource<
    { id: string; kind: string; detail: string; created_at: number }[]
  >("/events", refresh);
  async function toggle(key: string, value: boolean) {
    try {
      await api("/operations", {
        method: "PUT",
        body: JSON.stringify({ [key]: value }),
      });
      reload();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <div className="settings-stack">
      <section className="settings-card">
        <header>
          <div>
            <h2>Sending controls</h2>
            <p>
              Enable after verifying the mailbox and switching off your previous
              support system’s auto reply.
            </p>
          </div>
        </header>
        <div className="card-body">
          <label className="toggle-row">
            <div>
              <strong>Send outgoing messages</strong>
              <p>Process queued replies through connected Google mailboxes.</p>
            </div>
            <input
              type="checkbox"
              role="switch"
              checked={health?.sending_enabled || false}
              onChange={(e) => void toggle("sending_enabled", e.target.checked)}
            />
          </label>
          <label className="toggle-row">
            <div>
              <strong>Automatic acknowledgements</strong>
              <p>
                Apply the per-inbox acknowledgement settings to new
                conversations.
              </p>
            </div>
            <input
              type="checkbox"
              role="switch"
              checked={health?.acknowledgements_enabled || false}
              onChange={(e) =>
                void toggle("acknowledgements_enabled", e.target.checked)
              }
            />
          </label>
          <label className="toggle-row">
            <div>
              <strong>Track email opens</strong>
              <p>
                Show when an image in a sent reply loads. Privacy tools,
                scanners, and other recipients can affect this estimate.
              </p>
              {!health?.open_tracking_available && (
                <p>
                  Deploy the optional tracking Worker to enable this setting.
                  See the deployment guide.
                </p>
              )}
            </div>
            <input
              type="checkbox"
              role="switch"
              checked={health?.open_tracking_enabled || false}
              disabled={!health?.open_tracking_available}
              onChange={(e) =>
                void toggle("open_tracking_enabled", e.target.checked)
              }
            />
          </label>
          {health && !health.restore_reconciled && (
            <div className="notice danger">
              <strong>Restore reconciliation required</strong>
              <p>
                Sending stays paused until Gmail history and Sent mail have been
                reconciled.
              </p>
              <button
                className="button"
                onClick={() =>
                  void api<{ uncertain: number }>("/recovery/reconcile", {
                    method: "POST",
                    body: "{}",
                  })
                    .then((r) => {
                      notify(
                        `Gmail reconciliation complete. ${r.uncertain} sends need manual review.`,
                      );
                      reload();
                    })
                    .catch((e) => notify(e.message))
                }
              >
                Reconcile Gmail
              </button>
            </div>
          )}
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>Connection health</h2>
          <button
            className="icon-button"
            title="Refresh health"
            onClick={reload}
          >
            <RefreshCw size={15} />
          </button>
        </header>
        <div className="card-body">
          {!health?.mailboxes.length && (
            <p className="muted">No mailboxes connected yet.</p>
          )}
          {health?.mailboxes.map((m) => (
            <div className="health-row" key={m.id}>
              <div>
                <strong>{m.email}</strong>
                <small>
                  {m.error ||
                    `Last synchronized: ${m.last_sync_at ? dateTime(m.last_sync_at) : "Waiting for first check"}`}
                </small>
              </div>
              <span
                className={`connection-badge ${!m.error && m.last_sync_at && Date.now() - m.last_sync_at < 300000 ? "connected" : ""}`}
              >
                {m.error
                  ? "Needs attention"
                  : m.last_sync_at && Date.now() - m.last_sync_at < 300000
                    ? "Healthy"
                    : "Waiting"}
              </span>
            </div>
          ))}
          <div className="health-row">
            <div>
              <strong>Daily backup</strong>
              {health?.backup_error && (
                <p className="provider-error">{health.backup_error}</p>
              )}
              <small>
                {health?.backup
                  ? dateTime(health.backup.at)
                  : "The first backup has not run yet."}
              </small>
            </div>
            <button
              className="button"
              onClick={() =>
                void api("/backup", { method: "POST", body: "{}" })
                  .then(() => notify("Backup queued. Refresh health shortly."))
                  .catch((e) => notify(e.message))
              }
            >
              Back up now
            </button>
            <span className="connection-badge">30-day retention</span>
          </div>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>Outgoing messages</h2>
          <span className="connection-badge">
            {health?.jobs.length || 0} pending / failed
          </span>
        </header>
        <div className="card-body">
          {!health?.jobs.length && (
            <p className="muted">No pending or failed sends.</p>
          )}
          {health?.jobs.map((j) => (
            <div className="health-row" key={j.id}>
              <div>
                <strong>
                  {j.kind} · {j.state}
                </strong>
                <small>{j.error || dateTime(j.created_at)}</small>
              </div>
              <a className="text-button" href={`/?ticket=${j.conversation_id}`}>
                Open ticket
                <ExternalLink size={13} />
              </a>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>Recent activity</h2>
        </header>
        <div className="card-body">
          {!events.data?.length && (
            <p className="muted">
              Connection, recovery, and backup events will appear here.
            </p>
          )}
          {events.data?.map((e) => (
            <div className="activity-row" key={e.id}>
              <span className="activity-dot" />
              <div>
                <strong>{e.kind.replace(/_/g, " ")}</strong>
                <p>{e.detail}</p>
              </div>
              <time>{dateTime(e.created_at)}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
