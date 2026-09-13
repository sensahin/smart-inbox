import { FilePenLine, Trash2 } from "lucide-react";
import { api, dateTime, useResource } from "./api";
export type DraftItem = {
  id: string;
  conversation_id: string | null;
  version: number;
  updated_at: number;
  contact_name: string;
  subject: string;
  preview: string;
  ai: boolean;
};
export function Drafts({
  refresh,
  open,
  compose,
  reload,
  notify,
}: {
  refresh: number;
  open: (id: string) => void;
  compose: () => void;
  reload: () => void;
  notify: (s: string) => void;
}) {
  const drafts = useResource<DraftItem[]>("/drafts", refresh);
  async function discard(item: DraftItem) {
    try {
      await api(
        `/drafts/${encodeURIComponent(item.id)}?version=${item.version}`,
        { method: "DELETE" },
      );
      reload();
      notify("Draft discarded.");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <section className="conversation-list">
      <header className="list-toolbar">
        <h1 id="folder-title" tabIndex={-1}>
          Drafts
        </h1>
      </header>
      {drafts.error && <p role="alert">{drafts.error}</p>}
      {drafts.data?.length === 0 && (
        <div className="empty-state">
          <FilePenLine size={28} />
          <h2>No drafts</h2>
          <p>Replies you write and AI drafts awaiting review appear here.</p>
        </div>
      )}
      {drafts.data?.map((d) => (
        <div className="draft-list-row" key={d.id}>
          <button
            className="draft-list-open"
            onClick={() =>
              d.conversation_id ? open(d.conversation_id) : compose()
            }
          >
            <span>
              <strong>{d.contact_name}</strong>
              {d.ai && (
                <span className="customer-badge positive">AI draft</span>
              )}
            </span>
            <strong>{d.subject}</strong>
            <span className="muted">{d.preview}</span>
            <time>{dateTime(d.updated_at)}</time>
          </button>
          <button
            className="icon-button"
            aria-label={`Discard draft: ${d.subject}`}
            onClick={() => void discard(d)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </section>
  );
}
