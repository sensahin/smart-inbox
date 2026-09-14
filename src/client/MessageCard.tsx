import { useContext, useEffect, useRef, useState, type Ref } from "react";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MoreHorizontal,
  MailOpen,
  Paperclip,
} from "lucide-react";
import type { Message } from "../shared/types";
import { dateTime, initials, relative } from "./api";
import { AutoLoadImagesContext } from "./AutoLoadImagesContext";

export function MessageCard({
  message: m,
  latest,
  articleRef,
}: {
  message: Message;
  latest: boolean;
  articleRef?: Ref<HTMLElement>;
}) {
  const autoLoadImages = useContext(AutoLoadImagesContext);
  const [expanded, setExpanded] = useState(latest || m.direction === "inbound");
  return (
    <article
      ref={articleRef}
      className={`message-card ${m.direction}`}
      tabIndex={-1}
      aria-label={`Email from ${m.sender_name || m.sender}`}
    >
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
          <EmailFrame
            key={autoLoadImages ? "automatic" : "manual"}
            message={m}
            autoLoadImages={autoLoadImages}
          />
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

function EmailFrame({
  message: m,
  autoLoadImages,
}: {
  message: Message;
  autoLoadImages: boolean;
}) {
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
      {hasRemoteImages && !autoLoadImages && (
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
        src={`/api/messages/${m.id}/render${autoLoadImages || showImages ? "?images=show" : ""}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        className="email-frame"
        style={{ height }}
      />
    </>
  );
}
