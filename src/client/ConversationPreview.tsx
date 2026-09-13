import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Conversation } from "../shared/types";
import type { Detail } from "./Conversation";
import { api, useResource } from "./api";
import { MessageCard } from "./MessageCard";

export function ConversationPreview({
  id,
  current,
  close,
  open,
  merged,
  reloadCurrent,
  returnFocus,
}: {
  id: string;
  current: Conversation;
  close: () => void;
  open: (id: string) => void;
  merged: () => void;
  reloadCurrent: () => void;
  returnFocus: HTMLElement | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const inFlight = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const detail = useResource<Detail>(`/conversations/${id}`, refresh);
  const source = detail.data?.conversation;
  const messages =
    detail.data?.messages.filter((m) => m.direction !== "auto") || [];
  const unavailable =
    source &&
    (source.id === current.id
      ? "These conversations are already merged."
      : source.deleted_at !== null || current.deleted_at !== null
        ? "Restore conversations from Trash before merging."
        : source.contact_id !== current.contact_id ||
            source.inbox_id !== current.inbox_id ||
            !source.mailbox_id ||
            source.mailbox_id !== current.mailbox_id
          ? "Merge is available for conversations with the same customer, inbox, and mailbox."
          : "");
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  async function merge() {
    if (inFlight.current || !source || unavailable) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/conversations/${current.id}/merge`, {
        method: "POST",
        body: JSON.stringify({
          source_id: source.id,
          source_revision: source.revision,
          target_revision: current.revision,
        }),
      });
      merged();
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
      setRefresh((value) => value + 1);
      reloadCurrent();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="conversation-preview"
      aria-labelledby={headingId}
      onCancel={(e) => {
        e.preventDefault();
        if (!inFlight.current) close();
      }}
    >
      <header className="preview-header">
        <h2 id={headingId} title={source?.subject}>
          {source?.subject || "Conversation preview"}
        </h2>
        {source && (
          <span className={`ticket-status preview-status ${source.status}`}>
            {source.deleted_at !== null
              ? "Trash"
              : source.status === "open"
                ? "Open"
                : source.status === "waiting"
                  ? "Waiting"
                  : "Closed"}
          </span>
        )}
        <button
          className="icon-button"
          aria-label="Close preview"
          disabled={busy}
          onClick={close}
          autoFocus
        >
          <X size={20} />
        </button>
      </header>
      <div className="preview-scroll">
        {detail.error ? (
          <div className="notice danger" role="alert">
            {detail.error}
            <button
              className="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : !detail.data ? (
          <p role="status">Loading conversation…</p>
        ) : (
          <div className="preview-messages">
            <div className="preview-title">
              <span className="ticket-id">#{source!.number}</span>
              <h3>{source!.subject}</h3>
            </div>
            {messages.map((m, i) => (
              <MessageCard
                key={m.id}
                message={m}
                latest={i === messages.length - 1}
              />
            ))}
            {!messages.length && <p className="muted">No messages yet.</p>}
          </div>
        )}
      </div>
      <footer className="preview-footer" aria-busy={busy}>
        {error && (
          <p className="preview-error" role="alert">
            {error}
          </p>
        )}
        {confirming ? (
          <>
            <p>
              Merge this conversation into <strong>#{current.number}</strong>?
              Messages and attachments will be combined under the current
              subject. This cannot be undone.
            </p>
            <div className="preview-buttons">
              <button
                className="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || !!unavailable}
                onClick={() => void merge()}
              >
                {busy ? "Merging…" : "Confirm merge"}
              </button>
            </div>
          </>
        ) : (
          <>
            {unavailable && <p className="muted">{unavailable}</p>}
            <div className="preview-buttons">
              <button
                className="button primary"
                disabled={!source || !!detail.error}
                onClick={() => source && open(source.id)}
              >
                Open
              </button>
              <button
                className="button"
                disabled={
                  !source || !!unavailable || !!detail.error || detail.loading
                }
                onClick={() => {
                  setError("");
                  setConfirming(true);
                }}
              >
                Merge
              </button>
            </div>
          </>
        )}
      </footer>
    </dialog>
  );
}
