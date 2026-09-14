import { useState } from "react";
import { Save, Upload } from "lucide-react";
import type { WorkspaceSettings } from "../shared/workspace";
import { api } from "./api";

export function GeneralSettings({
  workspace,
  reload,
  notify,
}: {
  workspace: WorkspaceSettings;
  reload: () => void;
  notify: (message: string) => void;
}) {
  const [form, setForm] = useState(workspace);
  const [identifiers, setIdentifiers] = useState(
    workspace.subject_identifiers.join(", "),
  );
  const [busy, setBusy] = useState(false);
  const patch = (values: Partial<WorkspaceSettings>) =>
    setForm((f) => ({ ...f, ...values }));
  async function save() {
    setBusy(true);
    try {
      await api("/workspace", {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          subject_identifiers: identifiers
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        }),
      });
      reload();
      notify("Workspace settings saved.");
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
          <h2>Workspace</h2>
        </header>
        <div className="card-body">
          <label className="field">
            <span>Workspace name</span>
            <input
              value={form.name}
              maxLength={60}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <small>
              Shown in navigation and the browser title. New inboxes use this as
              their initial sending name.
            </small>
          </label>
          <div className="workspace-logo-field">
            {form.logo && <img src={form.logo} alt="Workspace logo preview" />}
            <label className="file-import">
              <Upload size={14} /> Upload logo
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  if (
                    file.size > 100000 ||
                    !["image/png", "image/jpeg", "image/webp"].includes(
                      file.type,
                    )
                  ) {
                    notify("Choose a PNG, JPEG or WebP under 100 KB.");
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => patch({ logo: String(reader.result) });
                  reader.onerror = () => notify("The logo could not be read.");
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            {form.logo && (
              <button
                className="text-button"
                onClick={() => patch({ logo: "" })}
              >
                Remove logo
              </button>
            )}
          </div>
          <label className="field">
            <span>Documentation link</span>
            <input
              type="url"
              value={form.documentation_url}
              placeholder="https://docs.your-domain.com/"
              onChange={(e) => patch({ documentation_url: e.target.value })}
            />
            <small>
              Optional link in the left sidebar. Configure AI reference indexing
              separately in AI settings.
            </small>
          </label>
          <label className="field">
            <span>Default time zone</span>
            <input
              value={form.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
            />
            <small>
              Used for office hours in new inboxes. Existing inbox settings are
              preserved.
            </small>
          </label>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>Email display</h2>
        </header>
        <div className="card-body">
          <label className="toggle-row">
            <div>
              <strong>Load external images automatically</strong>
              <p id="external-images-help">
                Display images without clicking Show images. Loading images
                contacts the sender’s servers and may trigger open tracking.
              </p>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-label="Load external images automatically"
              aria-describedby="external-images-help"
              checked={form.load_external_images}
              onChange={(e) =>
                patch({ load_external_images: e.target.checked })
              }
            />
          </label>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <h2>Contact form subjects</h2>
        </header>
        <div className="card-body">
          <p className="field-help">
            Optionally shorten Freemius contact form subjects to [Product ·
            Plan] — Customer subject. Leave these fields empty to keep original
            subjects.
          </p>
          <label className="field">
            <span>Product display name</span>
            <input
              value={form.product_name}
              maxLength={60}
              onChange={(e) => patch({ product_name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Matching plugin names or slugs</span>
            <input
              value={identifiers}
              onChange={(e) => setIdentifiers(e.target.value)}
              placeholder="my-plugin, My Product"
            />
            <small>
              Comma-separated exact values from the original [Plugin: …] header.
              Applies to new conversations and outgoing subjects.
            </small>
          </label>
        </div>
      </section>
      <div className="settings-save">
        <span />
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void save()}
        >
          <Save size={15} />
          {busy ? "Saving…" : "Save workspace"}
        </button>
      </div>
    </div>
  );
}
