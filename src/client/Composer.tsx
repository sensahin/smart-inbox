import { AIDraft } from "./AIDraft";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import ImageExtension from "@tiptap/extension-image";
import {
  Bold,
  ChevronDown,
  ImagePlus,
  Italic,
  Link,
  List,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import type {
  Attachment,
  Contact,
  Conversation,
  Draft,
  Inbox,
  Message,
  Outgoing,
  SavedReply,
  Status,
} from "../shared/types";
import { api, plainHtml, useResource } from "./api";
type Form = {
  ai_run_id?: string;
  inbox_id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  text: string;
  attachment_ids: string[];
  attachments: Attachment[];
  kind: "new" | "reply" | "forward";
  idempotency_key: string;
};
const split = (value: string) =>
  value
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
export function Composer({
  inboxes,
  conversation,
  contact,
  lastMessage,
  onSent,
  notify,
  autoFocus = false,
}: {
  inboxes: Inbox[];
  conversation?: Conversation;
  contact?: Contact;
  lastMessage?: Message;
  onSent: (id: string) => void;
  notify: (s: string) => void;
  autoFocus?: boolean;
}) {
  const draftId = conversation
    ? `reply:${conversation.id}`
    : "new-conversation";
  const draft = useResource<Draft>(`/drafts/${draftId}`),
    replies = useResource<SavedReply[]>("/saved-replies");
  const initial: Form = {
    inbox_id: conversation?.inbox_id || inboxes[0]?.id || "",
    to: contact?.email || "",
    cc: "",
    bcc: "",
    subject: conversation?.subject || "",
    html: "",
    text: "",
    attachment_ids: [],
    attachments: [],
    kind: conversation ? "reply" : "new",
    idempotency_key: crypto.randomUUID(),
  };
  const [form, setForm] = useState<Form>(initial),
    [extras, setExtras] = useState(false),
    [status, setStatus] = useState<Status>("closed"),
    [saveState, setSaveState] = useState(""),
    [sendError, setSendError] = useState(""),
    [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false),
    [loaded, setLoaded] = useState(false);
  const version = useRef(0),
    loadedOnce = useRef(false),
    blocked = useRef(false),
    submitted = useRef(false),
    current = useRef<Form>(initial),
    saveChain = useRef(Promise.resolve()),
    lastSaved = useRef("");
  const inputRef = useRef<HTMLInputElement>(null),
    imageRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [
      ImageExtension,
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: conversation ? "Write your reply…" : "Write a message…",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        "aria-label": "Message body",
        role: "textbox",
        "aria-multiline": "true",
      },
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text !== undefined) {
          event.preventDefault();
          editor?.commands.insertContent(plainHtml(text));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) =>
      setForm((f) => ({ ...f, html: e.getHTML(), text: e.getText() })),
  });
  useEffect(() => {
    if (draft.loading || loadedOnce.current || !editor) return;
    if (draft.error) {
      setSaveState(draft.error);
      return;
    }
    loadedOnce.current = true;
    const stored = draft.data ? (JSON.parse(draft.data.payload) as Form) : null;
    if (stored) {
      version.current = draft.data!.version;
      lastSaved.current = JSON.stringify(stored);
      setForm(stored);
      editor.commands.setContent(stored.html, { emitUpdate: false });
    } else if (lastMessage) {
      const headers = JSON.parse(lastMessage.headers) as Record<string, string>;
      const replyTo = headers["reply-to-addresses"]
        ? (JSON.parse(headers["reply-to-addresses"]) as string[])
        : [];
      setForm((f) => ({
        ...f,
        to: replyTo.length ? replyTo.join(", ") : contact?.email || f.to,
      }));
    }
    setLoaded(true);
  }, [draft.loading, draft.error, draft.data, editor, lastMessage, contact]);
  useEffect(() => {
    if (autoFocus && loaded) editor?.commands.focus("end");
  }, [autoFocus, loaded, editor]);
  useEffect(() => {
    current.current = form;
  }, [form]);
  const persist = () => {
    if (!loadedOnce.current || blocked.current || submitted.current)
      return saveChain.current;
    const snapshot = current.current;
    if (
      version.current === 0 &&
      !snapshot.text.trim() &&
      (conversation || !snapshot.subject.trim()) &&
      !snapshot.attachments.length
    )
      return saveChain.current;
    saveChain.current = saveChain.current.then(async () => {
      if (
        submitted.current ||
        blocked.current ||
        JSON.stringify(snapshot) === lastSaved.current
      )
        return;
      setSaveState("Saving…");
      try {
        if (
          version.current &&
          !snapshot.text.trim() &&
          !snapshot.attachments.length &&
          (conversation || !snapshot.subject.trim())
        ) {
          await api(`/drafts/${draftId}?version=${version.current}`, {
            method: "DELETE",
          });
          version.current = 0;
          lastSaved.current = JSON.stringify(snapshot);
          setSaveState("Draft cleared");
          return;
        }
        const result = await api<{ version: number }>(`/drafts/${draftId}`, {
          method: "PUT",
          body: JSON.stringify({
            version: version.current,
            conversation_id: conversation?.id || null,
            payload: snapshot,
          }),
        });
        version.current = result.version;
        lastSaved.current = JSON.stringify(snapshot);
        setSaveState("Draft saved");
      } catch (e) {
        blocked.current = true;
        setSaveState((e as Error).message);
      }
    });
    return saveChain.current;
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void persistRef.current();
    }, 900);
    return () => clearTimeout(timer);
  }, [form, loaded]);
  useEffect(
    () => () => {
      void persistRef.current();
    },
    [],
  );
  const inbox = inboxes.find((i) => i.id === form.inbox_id);
  useEffect(() => {
    setStatus(inbox?.default_status || "closed");
  }, [inbox?.id, inbox?.default_status]);
  async function upload(file: File, inline = false) {
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      if (inline) body.set("inline", "1");
      if (conversation) body.set("conversation_id", conversation.id);
      const a = await api<Attachment>("/attachments", { method: "POST", body });
      setForm((f) => ({
        ...f,
        attachments: [...f.attachments, a],
        attachment_ids: [...f.attachment_ids, a.id],
      }));
      if (inline)
        editor
          ?.chain()
          .focus()
          .setImage({ src: `/api/attachments/${a.id}/inline`, alt: a.filename })
          .run();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function send() {
    if (!editor || blocked.current) return;
    setSendError("");
    setSending(true);
    try {
      await persist();
      if (blocked.current)
        throw new Error("Resolve the draft conflict before sending.");
      submitted.current = true;
      const result = await api<Outgoing>("/send", {
        method: "POST",
        body: JSON.stringify({
          inbox_id: form.inbox_id,
          to: split(form.to),
          cc: split(form.cc),
          bcc: split(form.bcc),
          subject: form.subject,
          html: editor.getHTML(),
          text: editor.getText(),
          attachment_ids: form.attachment_ids,
          kind: form.kind,
          status,
          conversation_id: conversation?.id,
          draft_id: draftId,
          draft_version: version.current || undefined,
          idempotency_key: form.idempotency_key,
        }),
      });
      notify("Reply queued. The ticket updates after Gmail accepts it.");
      editor.commands.clearContent();
      setForm(initial);
      onSent(result.conversation_id);
    } catch (e) {
      submitted.current = false;
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function mode(next: "reply" | "reply-all" | "forward") {
    if (next === "forward" && lastMessage) {
      const body = await api<{ text: string }>(
        `/messages/${lastMessage.id}/text`,
      );
      editor?.commands.setContent(
        plainHtml(
          `\n\n---------- Forwarded message ----------\nFrom: ${lastMessage.sender}\nSubject: ${lastMessage.subject}\n\n${body.text}`,
        ),
      );
      setForm((f) => ({
        ...f,
        kind: "forward",
        to: "",
        cc: "",
        subject: `Fwd: ${conversation?.subject || ""}`,
        attachments: lastMessage.attachments || [],
        attachment_ids: lastMessage.attachments?.map((a) => a.id) || [],
      }));
      return;
    }
    const replyHeaders = lastMessage
      ? (JSON.parse(lastMessage.headers) as Record<string, string>)
      : {};
    const replyTo = replyHeaders["reply-to-addresses"]
      ? (JSON.parse(replyHeaders["reply-to-addresses"]) as string[])
      : [];
    const primary = replyTo.length ? replyTo : [contact?.email || ""];
    const excluded = new Set([...inboxes.map((i) => i.address), ...primary]);
    const recipients = lastMessage
      ? [
          ...(JSON.parse(lastMessage.recipients) as string[]),
          ...(JSON.parse(lastMessage.cc) as string[]),
        ]
      : [];
    const cc = [...new Set(recipients)].filter(
      (a) => !excluded.has(a) && a !== contact?.email,
    );
    setForm((f) => ({
      ...f,
      kind: "reply",
      to: primary.join(", "),
      cc: next === "reply-all" ? cc.join(", ") : "",
      subject: conversation?.subject || "",
    }));
    if (next === "reply-all") setExtras(true);
  }
  function insertReply(id: string) {
    const reply = replies.data?.find((r) => r.id === id);
    if (!reply) return;
    const values: Record<string, string> = {
      "customer.firstName":
        contact?.name === contact?.email
          ? ""
          : contact?.name.split(" ")[0] || "",
      "customer.fullName": contact?.name || "",
      "customer.email": contact?.email || form.to,
      "inbox.name": inbox?.name || "",
      "ticket.number": String(conversation?.number || ""),
    };
    const text = reply.body.replace(
      /\{\{([\w.]+)(?:\|([^}]*))?\}\}/g,
      (_, k: string, f: string) => values[k] || f || "",
    );
    editor?.chain().focus().insertContent(plainHtml(text)).run();
  }
  async function loadAIDraft() {
    if (current.current.text.trim() || current.current.attachments.length)
      throw new Error(
        "Discard or send your current draft before loading another.",
      );
    await saveChain.current;
    const stored = await api<Draft | null>(`/drafts/${draftId}`);
    if (!stored) throw new Error("This draft is no longer available.");
    const next = JSON.parse(stored.payload) as Form;
    version.current = stored.version;
    lastSaved.current = JSON.stringify(next);
    blocked.current = false;
    current.current = next;
    setForm(next);
    editor?.commands.setContent(next.html, { emitUpdate: false });
    setSaveState("AI draft loaded · Review before sending");
  }
  async function discardDraft() {
    await saveChain.current;
    if (version.current)
      await api(`/drafts/${draftId}?version=${version.current}`, {
        method: "DELETE",
      });
    version.current = 0;
    lastSaved.current = "";
    blocked.current = false;
    const next = {
      ...initial,
      to: form.to,
      idempotency_key: crypto.randomUUID(),
    };
    current.current = next;
    setForm(next);
    editor?.commands.setContent("", { emitUpdate: false });
    setSaveState("Draft discarded");
  }
  return (
    <div className="composer">
      {conversation && (
        <AIDraft
          conversationId={conversation.id}
          lastInboundId={conversation.last_inbound_id}
          loadedRun={form.ai_run_id}
          onLoad={loadAIDraft}
          beforeGenerate={async () => {
            await persist();
            if (blocked.current)
              throw new Error("Resolve the draft conflict first.");
          }}
          notify={notify}
        />
      )}
      {(form.text.trim() || form.attachments.length > 0) && (
        <button
          className="button composer-discard"
          disabled={sending}
          onClick={() => void discardDraft().catch((e) => notify(e.message))}
        >
          Discard draft
        </button>
      )}
      <div className="composer-top">
        <div className="reply-mode">
          {conversation ? (
            <select
              aria-label="Reply mode"
              value={
                form.kind === "forward"
                  ? "forward"
                  : form.cc
                    ? "reply-all"
                    : "reply"
              }
              onChange={(e) =>
                void mode(
                  e.target.value as "reply" | "reply-all" | "forward",
                ).catch((e) => notify(e.message))
              }
            >
              <option value="reply">Reply</option>
              <option value="reply-all">Reply all</option>
              <option value="forward">Forward</option>
            </select>
          ) : (
            <span>New message</span>
          )}
          <span className="from-label">from</span>
          <select
            aria-label="From inbox"
            value={form.inbox_id}
            disabled={!!conversation}
            onChange={(e) =>
              setForm((f) => ({ ...f, inbox_id: e.target.value }))
            }
          >
            {inboxes.map((i) => (
              <option value={i.id} key={i.id}>
                {i.address}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="recipient-row">
        <span>To</span>
        <input
          aria-label="To"
          value={form.to}
          placeholder="customer@example.com"
          onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
        />
        <button
          type="button"
          aria-expanded={extras}
          onClick={() => setExtras(!extras)}
        >
          Cc / Bcc
        </button>
      </label>
      {extras && (
        <>
          <label className="recipient-row">
            <span>Cc</span>
            <input
              value={form.cc}
              onChange={(e) => setForm((f) => ({ ...f, cc: e.target.value }))}
            />
          </label>
          <label className="recipient-row">
            <span>Bcc</span>
            <input
              value={form.bcc}
              onChange={(e) => setForm((f) => ({ ...f, bcc: e.target.value }))}
            />
          </label>
        </>
      )}
      {(!conversation || form.kind === "forward") && (
        <label className="recipient-row">
          <span>Subject</span>
          <input
            value={form.subject}
            placeholder="Subject"
            onChange={(e) =>
              setForm((f) => ({ ...f, subject: e.target.value }))
            }
          />
        </label>
      )}
      <EditorContent editor={editor} />
      {inbox?.signature && (
        <div className="signature-preview">
          {inbox.signature}
          <small>Inbox signature · added when sending</small>
        </div>
      )}
      {!!form.attachments.length && (
        <div className="composer-files">
          {form.attachments.map((a) => (
            <span key={a.id}>
              <Paperclip size={13} />
              {a.filename}
              <button
                aria-label={`Remove ${a.filename}`}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    attachments: f.attachments.filter((x) => x.id !== a.id),
                    attachment_ids: f.attachment_ids.filter(
                      (id) => id !== a.id,
                    ),
                  }))
                }
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="editor-toolbar">
        <div className="format-buttons">
          <button
            title="Bold"
            aria-label="Bold"
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <Bold size={15} />
          </button>
          <button
            title="Italic"
            aria-label="Italic"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <Italic size={15} />
          </button>
          <button
            title="Bullet list"
            aria-label="Bullet list"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <List size={16} />
          </button>
          <button
            title="Insert link"
            aria-label="Insert link"
            onClick={() => {
              const url = prompt("Link URL");
              if (url && /^https?:\/\//i.test(url))
                editor?.chain().focus().setLink({ href: url }).run();
            }}
          >
            <Link size={15} />
          </button>
          <span />
          <button
            title="Attach a file"
            aria-label="Attach a file"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            <Paperclip size={16} />
          </button>
          <input
            type="file"
            ref={inputRef}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          <button
            title="Insert inline image"
            aria-label="Insert inline image"
            onClick={() => imageRef.current?.click()}
            disabled={uploading}
          >
            <ImagePlus size={16} />
          </button>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            ref={imageRef}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file, true);
              e.target.value = "";
            }}
          />
        </div>
        <select
          aria-label="Insert saved reply"
          value=""
          onChange={(e) => insertReply(e.target.value)}
        >
          <option value="">Saved replies</option>
          {replies.data?.map((r) => (
            <option value={r.id} key={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      </div>
      {sendError && (
        <p className="draft-error" role="alert">
          {sendError}
        </p>
      )}
      <div className="composer-footer">
        <span className={blocked.current ? "draft-error" : "draft-state"}>
          {uploading ? "Uploading…" : saveState}
          {blocked.current && (
            <button onClick={() => location.reload()}>Reload draft</button>
          )}
        </span>
        <div className="send-group">
          <button
            className="button primary"
            disabled={
              sending ||
              uploading ||
              (!form.text.trim() && !form.attachments.length) ||
              !form.to ||
              !inbox?.mailbox_id ||
              !loaded ||
              blocked.current
            }
            onClick={() => void send()}
          >
            <Send size={14} />
            {sending ? "Queueing…" : "Send"}
          </button>
          <label className="send-status">
            <select
              aria-label="Status after sending"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              <option value="closed">Closed</option>
              <option value="waiting">Waiting</option>
              <option value="open">Open</option>
            </select>
            <ChevronDown size={15} />
          </label>
        </div>
      </div>
    </div>
  );
}
