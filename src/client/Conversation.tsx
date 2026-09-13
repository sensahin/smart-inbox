import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Reply, RotateCcw } from "lucide-react";
import type {
  Contact,
  Conversation,
  Inbox,
  Message,
  Outgoing,
  Status,
  BulkResult,
} from "../shared/types";
import { api, useResource } from "./api";
import { MessageCard } from "./MessageCard";
import { Composer } from "./Composer";
import { CustomerSidebar } from "./CustomerSidebar";
import { ConversationMenu } from "./ConversationMenu";
import type { Notify } from "./Toast";
export type Detail = {
  conversation: Conversation;
  messages: Message[];
  contact: Contact;
  history: Conversation[];
  jobs: Outgoing[];
  events: { kind: string; detail: string; created_at: number }[];
};
export function ConversationView({
  id,
  refresh,
  inboxes,
  reload,
  onRead,
  notify,
  select,
  openContact,
  close,
}: {
  id: string;
  refresh: number;
  inboxes: Inbox[];
  reload: () => void;
  onRead: () => void;
  notify: Notify;
  select: (id: string) => void;
  openContact: (id: string) => void;
  close: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const latestMessageRef = useRef<HTMLElement>(null);
  const readingColumnRef = useRef<HTMLDivElement>(null);
  const viewActive = useRef(true);
  const [readReady, setReadReady] = useState(false);
  const detail = useResource<Detail>(
    readReady ? `/conversations/${id}` : null,
    refresh,
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [actionSaving, setActionSaving] = useState(false);
  const actionInFlight = useRef(false);
  useEffect(() => {
    viewActive.current = true;
    void api(`/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ unread: false }),
    })
      .then(onRead)
      .catch(() => {})
      .finally(() => {
        if (viewActive.current) setReadReady(true);
      });
    return () => {
      viewActive.current = false;
    };
  }, [id, onRead]);
  useEffect(() => {
    const resolved = detail.data?.conversation.id;
    if (resolved && resolved !== id) select(resolved);
  }, [detail.data?.conversation.id, id, select]);
  useLayoutEffect(() => {
    const target = latestMessageRef.current || titleRef.current;
    const column = readingColumnRef.current;
    if (!target || !column) return;
    const align = () =>
      target.scrollIntoView({ block: "start", behavior: "instant" });
    target.focus({ preventScroll: true });
    align();
    // Email frames resize after loading. Hold the opening position until the reader interacts.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    });
    const interactions = ["wheel", "touchstart", "pointerdown", "keydown"];
    const inputDocuments = new Set<Document>();
    const stop = () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      column.removeEventListener("load", frameLoaded, true);
      inputDocuments.forEach((doc) =>
        interactions.forEach((event) =>
          doc.removeEventListener(event, stop, true),
        ),
      );
      inputDocuments.clear();
    };
    const listen = (doc: Document) => {
      if (inputDocuments.has(doc)) return;
      inputDocuments.add(doc);
      interactions.forEach((event) =>
        doc.addEventListener(event, stop, { capture: true, passive: true }),
      );
    };
    const frameLoaded = (event: Event) => {
      if (
        event.target instanceof HTMLIFrameElement &&
        event.target.contentDocument
      )
        listen(event.target.contentDocument);
    };
    observer.observe(column);
    listen(document);
    column.addEventListener("load", frameLoaded, true);
    column.querySelectorAll("iframe").forEach((emailFrame) => {
      if (emailFrame.contentDocument) listen(emailFrame.contentDocument);
    });
    return stop;
  }, [detail.data?.conversation.id]);
  async function changeConversation(action: Status | "unread" | "trash") {
    if (actionInFlight.current || !detail.data) return;
    actionInFlight.current = true;
    setActionSaving(true);
    try {
      const result = await api<BulkResult>("/conversations/bulk", {
        method: "POST",
        body: JSON.stringify({
          action,
          items: [{ id, revision: detail.data.conversation.revision }],
        }),
      });
      if (!result.updated.includes(id)) {
        if (viewActive.current) reload();
        throw new Error(
          action === "trash"
            ? "This conversation changed or has an unfinished send. Review it and try again."
            : "This conversation changed. Review it and try again.",
        );
      }
      const outcome =
        action === "trash"
          ? "Conversation moved to Trash."
          : action === "unread"
            ? "Conversation marked unread."
            : `Status updated to ${action === "open" ? "Open" : action === "waiting" ? "Waiting" : "Closed"}.`;
      notify(outcome, "success");
      if (viewActive.current) close();
    } catch (e) {
      const operation =
        action === "trash"
          ? "move to Trash"
          : action === "unread"
            ? "mark unread"
            : "update status";
      notify(`Could not ${operation}. ${(e as Error).message}`, "error");
    } finally {
      actionInFlight.current = false;
      if (viewActive.current) setActionSaving(false);
    }
  }
  if (detail.error)
    return (
      <div className="detail-error">
        <p>{detail.error}</p>
        <button className="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!detail.data)
    return <div className="detail-loading">Loading conversation…</div>;
  const d = detail.data,
    c = d.conversation,
    messages = d.messages.filter((message) => message.direction !== "auto"),
    jobs = d.jobs.filter(
      (job) =>
        job.kind !== "auto" ||
        job.state === "failed" ||
        job.state === "uncertain",
    );
  return (
    <div className="detail-layout">
      <section className="conversation-detail">
        <header className="detail-actions" aria-label="Conversation toolbar">
          <div className="detail-heading">
            <span className="toolbar-subject" title={c.subject}>
              {c.subject}
            </span>
          </div>
          <div className="detail-controls" aria-busy={actionSaving}>
            <div className={`ticket-status ${c.status}`}>
              <select
                disabled={c.deleted_at !== null || actionSaving}
                aria-label="Ticket status"
                value={c.status}
                onChange={(e) =>
                  void changeConversation(e.target.value as Status)
                }
              >
                <option value="open">Open</option>
                <option value="waiting">Waiting</option>
                <option value="closed">Closed</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
            <span className="sr-only" role="status">
              {actionSaving ? "Updating conversation…" : ""}
            </span>
            <ConversationMenu
              disabled={c.deleted_at !== null || actionSaving}
              onAction={(action) => void changeConversation(action)}
            />
          </div>
        </header>
        <div className="detail-scroll">
          <div className="reading-column" ref={readingColumnRef}>
            <div className="conversation-title">
              <div>
                <h1 ref={titleRef} tabIndex={-1}>
                  {c.subject}
                </h1>
                <p>
                  <span className="ticket-id">#{c.number}</span>
                  <span>·</span>
                  {c.inbox_name}
                  <span>·</span>
                  {messages.length}{" "}
                  {messages.length === 1 ? "message" : "messages"}
                </p>
              </div>
            </div>
            {c.deleted_at !== null && (
              <div className="notice neutral">
                This conversation is in Trash. Restore it to reply.
                <button
                  className="button"
                  onClick={() =>
                    void api<BulkResult>("/conversations/bulk", {
                      method: "POST",
                      body: JSON.stringify({
                        action: "restore",
                        items: [{ id: c.id, revision: c.revision }],
                      }),
                    })
                      .then((result) => {
                        notify(
                          result.updated.length
                            ? "Conversation restored."
                            : "Conversation changed. Review it and try again.",
                        );
                        reload();
                      })
                      .catch((e) => notify(e.message))
                  }
                >
                  <RotateCcw size={16} /> Restore
                </button>
              </div>
            )}
            {d.events.map((e, i) => (
              <div className="notice danger" key={i}>
                {e.detail}
              </div>
            ))}
            {messages.map((m, i) => (
              <MessageCard
                key={m.id}
                message={m}
                latest={i === messages.length - 1}
                articleRef={
                  i === messages.length - 1 ? latestMessageRef : undefined
                }
              />
            ))}
            {!messages.length && (
              <p className="muted">
                Your first message will appear here after it is sent.
              </p>
            )}
            {jobs.map((j) => (
              <div
                className={`notice ${j.state === "failed" || j.state === "uncertain" ? "danger" : "neutral"}`}
                key={j.id}
              >
                <strong>
                  {j.kind === "auto" && "Automatic reply: "}
                  {j.state === "uncertain"
                    ? "Send needs verification"
                    : j.state === "failed"
                      ? "Send failed"
                      : j.state === "sending"
                        ? "Sending…"
                        : "Queued for sending"}
                </strong>
                {j.error && <p>{j.error}</p>}
                {c.deleted_at === null &&
                  ["failed", "uncertain"].includes(j.state) && (
                    <div className="notice-actions">
                      <button
                        onClick={() =>
                          void api<{ found: boolean }>(
                            `/outgoing/${j.id}/reconcile`,
                            { method: "POST", body: "{}" },
                          )
                            .then((r) => {
                              notify(
                                r.found
                                  ? "Message found in Gmail Sent."
                                  : "No matching message found yet.",
                              );
                              reload();
                            })
                            .catch((e) => notify(e.message))
                        }
                      >
                        Check Gmail Sent
                      </button>
                      <button
                        onClick={() => {
                          const verified =
                            j.state === "uncertain"
                              ? confirm(
                                  "Have you checked Gmail Sent and verified that this exact message was not sent? Retrying an uncertain send can create a duplicate.",
                                )
                              : false;
                          if (j.state === "uncertain" && !verified) return;
                          void api(`/outgoing/${j.id}/retry`, {
                            method: "POST",
                            body: JSON.stringify({
                              verified_not_sent: verified,
                            }),
                          })
                            .then(reload)
                            .catch((e) => notify(e.message));
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  )}
              </div>
            ))}
            {c.deleted_at === null &&
              (replyOpen ? (
                <Composer
                  autoFocus
                  inboxes={inboxes}
                  conversation={c}
                  contact={d.contact}
                  lastMessage={[...messages]
                    .reverse()
                    .find((m) => m.direction === "inbound")}
                  onSent={() => {
                    setReplyOpen(false);
                    reload();
                  }}
                  notify={notify}
                />
              ) : (
                <div className="reply-prompt">
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => setReplyOpen(true)}
                  >
                    <Reply size={16} aria-hidden="true" /> Reply
                  </button>
                </div>
              ))}
          </div>
        </div>
      </section>
      <CustomerSidebar
        detail={d}
        refresh={refresh}
        select={select}
        openContact={openContact}
        reload={reload}
        notify={notify}
      />
    </div>
  );
}
