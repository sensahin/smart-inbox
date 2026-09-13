import { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import type { AIConfig, AIRun } from "../shared/ai";
import { api, dateTime, useResource } from "./api";
type SettingsData = {
  model_check: {
    ok: boolean;
    model: string;
    at: number;
    error?: string;
    reply?: string;
  } | null;
  config: AIConfig;
  models: { id: string; name: string }[];
  github: { repo: string; access: "public" | "private"; configured: boolean };
  docs_updated: number | null;
  docs_error: string;
  docs_busy: boolean;
  today: { count: number; input_tokens: number; output_tokens: number };
  runs: AIRun[];
};
export function AISettings({ notify }: { notify: (s: string) => void }) {
  const [refresh, setRefresh] = useState(0),
    [form, setForm] = useState<AIConfig | null>(null),
    [busy, setBusy] = useState(false);
  const data = useResource<SettingsData>("/ai/settings", refresh);
  useEffect(() => {
    if (data.data && !form) setForm(data.data.config);
  }, [data.data, form]);
  useEffect(() => {
    const t = setInterval(() => setRefresh((v) => v + 1), 10000);
    return () => clearInterval(t);
  }, []);
  const update = (values: Partial<AIConfig>) =>
    setForm((f) => (f ? { ...f, ...values } : f));
  async function action(path: string, method = "POST", body?: unknown) {
    setBusy(true);
    try {
      await api(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      notify("AI settings updated.");
      setRefresh((v) => v + 1);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!form || !data.data) return <p>{data.error || "Loading AI settings…"}</p>;
  const current = data.data;
  return (
    <div className="ai-settings">
      <section className="settings-card">
        <header>
          <h2>AI replies</h2>
          <span className="customer-badge positive">Drafts only</span>
        </header>
        <div className="card-body">
          <label className="ai-checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            Prepare drafts for new customer messages
          </label>
          <p className="muted">
            Every reply stays in Drafts until you review it and click Send.
            Automated mail is always skipped. Eligibility and daily limits are
            checked before generation.
          </p>
          <label className="field">
            Customer eligibility
            <select
              value={form.eligibility}
              onChange={(e) =>
                update({
                  eligibility: e.target.value as AIConfig["eligibility"],
                })
              }
            >
              <option value="paid_freemius">
                Active paid customers verified by Freemius
              </option>
              <option value="all_customers">
                All customers (skip automated mail)
              </option>
            </select>
            <small>
              {form.eligibility === "paid_freemius"
                ? "Requires Freemius. Free, trial, expired and unverified accounts are skipped."
                : "Does not require Freemius. Any customer message can use the daily draft budget."}
            </small>
          </label>
          <div className="field-grid">
            <label className="field">
              Workers AI model
              <select
                value={form.model}
                onChange={(e) => update({ model: e.target.value })}
              >
                {current.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Daily draft limit (UTC)
              <input
                type="number"
                min={1}
                max={100}
                value={form.daily_limit}
                onChange={(e) =>
                  update({ daily_limit: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              Maximum research lookups
              <input
                type="number"
                min={1}
                max={5}
                value={form.max_steps}
                onChange={(e) => update({ max_steps: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="field">
            Reply instructions
            <textarea
              rows={6}
              value={form.instructions}
              onChange={(e) => update({ instructions: e.target.value })}
            />
          </label>
          <label className="ai-checkbox">
            <input
              type="checkbox"
              checked={form.use_history}
              onChange={(e) => update({ use_history: e.target.checked })}
            />
            Use earlier human replies from resolved conversations as references
          </label>
          <p className="muted">
            Enabling starts with new incoming messages. You can generate a draft
            on an existing open ticket for testing. Limits bound attempts and
            research; they are not a dollar spending cap.
          </p>
          <div className="ai-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void action("/ai/model-check", "POST", { model: form.model })
              }
            >
              {busy ? "Working…" : "Test model"}
            </button>
            <span className="muted">
              Synthetic draft only · up to five checks per day
            </span>
          </div>
          {current.model_check && (
            <p role="status">
              {current.model_check.ok
                ? `Model verified: ${current.model_check.model} · ${dateTime(current.model_check.at)}`
                : current.model_check.error}
            </p>
          )}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              const { revision: _, enabled_at: __, ...body } = form;
              void action("/ai/settings", "PUT", body);
            }}
          >
            <Save size={16} />
            Save AI settings
          </button>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>Reference sources</h2>
        </header>
        <div className="card-body">
          <h3>Documentation</h3>
          <label className="field">
            Documentation index URL
            <input
              type="url"
              value={form.documentation_index_url}
              placeholder="https://docs.your-domain.com/llms.txt"
              onChange={(e) =>
                update({ documentation_index_url: e.target.value })
              }
            />
            <small>
              Public llms.txt or Markdown index linking to Markdown pages on the
              same origin. Save with AI disabled, refresh the index, then enable
              AI.
            </small>
          </label>
          <p className="muted">
            {current.docs_updated
              ? `Indexed ${dateTime(current.docs_updated)}`
              : "Documentation has not been indexed yet."}
          </p>
          {current.docs_error && <p role="alert">{current.docs_error}</p>}
          <button
            className="button"
            disabled={
              busy ||
              current.docs_busy ||
              !current.config.documentation_index_url
            }
            onClick={() => void action("/ai/documentation/refresh")}
          >
            <RefreshCw size={15} />
            {current.docs_busy ? "Refreshing…" : "Refresh documentation"}
          </button>
          <h3>GitHub repository</h3>
          <label className="ai-checkbox">
            <input
              type="checkbox"
              checked={form.use_github}
              disabled={!current.github.configured}
              onChange={(e) => update({ use_github: e.target.checked })}
            />
            Use GitHub as a reference
          </label>
          <p className="muted">
            {current.github.configured
              ? `Repository: ${current.github.repo}. The agent reads relevant files and records the commit used.`
              : "Configure a GitHub repository in Connections first."}
          </p>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>AI activity</h2>
        </header>
        <div className="card-body">
          <p>
            {current.today.count} of {current.config.daily_limit} draft attempts
            today · {current.today.input_tokens.toLocaleString()} input /{" "}
            {current.today.output_tokens.toLocaleString()} output tokens
            recorded
          </p>
          <p className="muted">
            Failed calls may incur usage even when the provider does not return
            token counts.
          </p>
          {current.runs.length === 0 ? (
            <p className="muted">No AI drafts requested yet.</p>
          ) : (
            current.runs.map((r) => (
              <div className="ai-activity" key={r.id}>
                <a href={`/?ticket=${r.conversation_id}`}>
                  {r.state === "draft" ? "Draft ready" : r.state}
                </a>
                <time>{dateTime(r.created_at)}</time>
                {r.reason && <p>{r.reason}</p>}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
