import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MoreHorizontal,
  MailOpen,
  Paperclip,
  RotateCcw,
} from "lucide-react";
import type {
  Contact,
  Conversation,
  Inbox,
  Message,
  Outgoing,
  Status,
  BulkResult,
} from "../shared/types";
import { api, dateTime, initials, relative, useResource } from "./api";
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
  const viewActive = useRef(true);
  const [readReady, setReadReady] = useState(false);
  const detail = useResource<Detail>(
    readReady ? `/conversations/${id}` : null,
    refresh,
  );
  const [composerKey, setComposerKey] = useState(0);
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
    titleRef.current?.focus({ preventScroll: true });
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
          <div className="reading-column">
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
            {c.deleted_at === null && (
              <Composer
                key={`${id}:${composerKey}`}
                inboxes={inboxes}
                conversation={c}
                contact={d.contact}
                lastMessage={[...messages]
                  .reverse()
                  .find((m) => m.direction === "inbound")}
                onSent={() => {
                  setComposerKey((v) => v + 1);
                  reload();
                }}
                notify={notify}
              />
            )}
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
function MessageCard({
  message: m,
  latest,
}: {
  message: Message;
  latest: boolean;
}) {
  const [expanded, setExpanded] = useState(latest || m.direction === "inbound");
  return (
    <article className={`message-card ${m.direction}`}>
      <header>
        <span
          className={`avatar small ${m.direction === "inbound" ? "hue-1" : "agent-avatar"}`}
        >
          {initials(m.sender_name || m.sender)}
        </span>
        <div className="message-identity">
          <strong>
            {m.sender_name || m.sender}
            {m.direction === "outbound" && <small>You</small>}
          </strong>
          <span>
            To {JSON.parse(m.recipients).join(", ")}
            {JSON.parse(m.cc).length
              ? " · Cc " + JSON.parse(m.cc).join(", ")
              : ""}
          </span>
        </div>
        <time title={dateTime(m.sent_at)}>{relative(m.sent_at)}</time>
        <button
          className="icon-button"
          aria-label={expanded ? "Collapse message" : "Expand message"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </header>
      {expanded ? (
        <>
          <EmailFrame message={m} />
          {m.direction === "outbound" && !!m.open_tracked && (
            <div
              className="message-open-status"
              title="Estimated from an image load. Privacy tools, scanners, or CC/BCC recipients can trigger it; no detected open does not mean unread."
            >
              <MailOpen size={14} aria-hidden="true" />
              {m.first_opened_at
                ? `Customer viewed on ${dateTime(m.first_opened_at)}`
                : "No open detected"}
            </div>
          )}
          {!!m.attachments?.length && (
            <div className="message-attachments">
              {m.attachments.map((a) => (
                <a key={a.id} href={`/api/attachments/${a.id}`}>
                  <Paperclip size={14} />
                  <span>
                    {a.filename}
                    <small>{(a.size / 1024).toFixed(0)} KB</small>
                  </span>
                  <ExternalLink size={12} />
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="collapsed-message">
          {m.search_text.slice(0, 130)}
          <MoreHorizontal size={15} />
        </p>
      )}
    </article>
  );
}

function EmailFrame({ message: m }: { message: Message }) {
  const ref = useRef<HTMLIFrameElement>(null),
    [height, setHeight] = useState(160),
    [hasRemoteImages, setHasRemoteImages] = useState(false),
    [showImages, setShowImages] = useState(false);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const resize = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.max(60, body.scrollHeight + 4));
    };
    const loaded = () => {
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body) {
        setHasRemoteImages(!!body.querySelector("[data-remote-image]"));
        observer = new ResizeObserver(resize);
        observer.observe(body);
      }
      resize();
    };
    frame.addEventListener("load", loaded);
    return () => {
      frame.removeEventListener("load", loaded);
      observer?.disconnect();
    };
  }, [m.id]);
  return (
    <>
      {hasRemoteImages && (
        <div className="email-image-control">
          <span>
            {showImages
              ? "External images loaded"
              : "External images are hidden"}
          </span>
          <button
            type="button"
            title="Showing images contacts the sender’s image servers."
            onClick={() => setShowImages((value) => !value)}
          >
            {showImages ? "Hide images" : "Show images"}
          </button>
        </div>
      )}
      <iframe
        ref={ref}
        title={`Email from ${m.sender_name || m.sender}`}
        src={`/api/messages/${m.id}/render${showImages ? "?images=show" : ""}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        className="email-frame"
        style={{ height }}
      />
    </>
  );
}
