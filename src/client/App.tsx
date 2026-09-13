import { DEFAULT_WORKSPACE, type WorkspaceSettings } from "../shared/workspace";
import { Drafts, type DraftItem } from "./Drafts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  FilePenLine,
  ArrowUpRight,
  Check,
  CircleHelp,
  Clock3,
  Inbox as InboxIcon,
  LifeBuoy,
  Mail,
  MailOpen,
  Trash2,
  RotateCcw,
  Menu,
  Plus,
  Search,
  Settings as SettingsIcon,
  Users,
  ChartNoAxesCombined,
  X,
} from "lucide-react";
import type {
  Conversation,
  Health,
  Inbox,
  Folder,
  BulkAction,
  BulkResult,
} from "../shared/types";
import { api, dateTime, initials, relative, useResource } from "./api";
import { ConversationView } from "./Conversation";
import { Settings } from "./Settings";
import { Composer } from "./Composer";
import { Toast, type Notice, type Notify } from "./Toast";
import { useUnreadTitle } from "./useUnreadTitle";
import { Contacts } from "./Contacts";
const Reports = lazy(() =>
  import("./Reports").then((module) => ({ default: module.Reports })),
);

type ListResult = {
  items: Conversation[];
  has_more: boolean;
};
const folders = [
  { id: "open", label: "Open", icon: InboxIcon },
  { id: "waiting", label: "Waiting", icon: Clock3 },
  { id: "closed", label: "Closed", icon: Check },
  { id: "trash", label: "Trash", icon: Trash2 },
] as const;

export function App() {
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<Record<string, number>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const composeDialog = useRef<HTMLDialogElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const returnToList = useRef(false);
  const params = new URLSearchParams(location.search);
  const [view, setView] = useState(
    ["settings", "drafts", "contacts", "reports"].includes(
      params.get("view") || "",
    )
      ? params.get("view")!
      : "inbox",
  );
  const [contactId, setContactId] = useState(params.get("contact") || "");
  const [refresh, setRefresh] = useState(0),
    [unreadRefresh, setUnreadRefresh] = useState(0),
    [inboxId, setInboxId] = useState(params.get("inbox") || ""),
    [status, setStatus] = useState<Folder>("open"),
    [selected, setSelected] = useState(params.get("ticket") || ""),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [compose, setCompose] = useState(false),
    [toast, setToast] = useState<Notice | null>(null),
    [sidebar, setSidebar] = useState(false);
  const notify: Notify = useCallback(
    (message, tone = "info") => setToast({ message, tone }),
    [],
  );
  const me = useResource<{ email: string; local: boolean }>("/me");
  const workspaceData = useResource<WorkspaceSettings>("/workspace", refresh);
  const workspace = workspaceData.data || DEFAULT_WORKSPACE;
  useUnreadTitle(
    refresh + unreadRefresh,
    !!me.data && !me.error,
    workspace.name,
  );
  const refreshUnread = useCallback(() => setUnreadRefresh((v) => v + 1), []);
  const inboxes = useResource<Inbox[]>("/inboxes", refresh);
  const health = useResource<Health>("/health", refresh);
  const folderCounts = useResource<Record<string, number>>(
    `/conversations/counts?inbox=${encodeURIComponent(inboxId)}`,
    refresh,
  );
  const list = useResource<ListResult>(
    `/conversations?status=${status}&inbox=${inboxId}&q=${encodeURIComponent(search)}&offset=${offset}`,
    refresh,
  );
  const drafts = useResource<DraftItem[]>("/drafts", refresh);
  const reload = () => setRefresh((v) => v + 1);
  const selectionCount = Object.keys(checked).length;
  const allChecked =
    !!list.data?.items.length &&
    list.data.items.every((c) => checked[c.id] !== undefined);
  useEffect(() => {
    setChecked({});
  }, [status, inboxId, query, search, offset, selected, view]);
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = selectionCount > 0 && !allChecked;
  }, [selectionCount, allChecked]);
  useEffect(() => {
    if (!list.data) return;
    const visible = new Set(list.data.items.map((c) => c.id));
    setChecked((current) =>
      Object.keys(current).every((id) => visible.has(id))
        ? current
        : Object.fromEntries(
            Object.entries(current).filter(([id]) => visible.has(id)),
          ),
    );
    if (!list.data.items.length && offset > 0 && !list.loading)
      setOffset((value) => Math.max(0, value - 50));
  }, [list.data, list.loading, offset]);
  async function bulkAction(action: BulkAction) {
    if (bulkBusy || !selectionCount) return;
    setBulkBusy(true);
    try {
      const result = await api<BulkResult>("/conversations/bulk", {
        method: "POST",
        body: JSON.stringify({
          action,
          items: Object.entries(checked).map(([id, revision]) => ({
            id,
            revision,
          })),
        }),
      });
      const outcome =
        action === "trash"
          ? "moved to Trash"
          : action === "restore"
            ? "restored"
            : `marked ${action}`;
      notify(
        `${result.updated.length} conversation${result.updated.length === 1 ? "" : "s"} ${outcome}.${result.skipped.length ? ` ${result.skipped.length} skipped: changed since selection${action === "trash" ? " or has an unfinished send" : ""}. Select again after reviewing.` : ""}`,
      );
      setChecked({});
      reload();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBulkBusy(false);
    }
  }
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRefresh((v) => v + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!compose) return;
    const dialog = composeDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [compose]);
  useEffect(() => {
    if (!selected && returnToList.current) {
      document.getElementById("folder-title")?.focus({ preventScroll: true });
      returnToList.current = false;
    }
  }, [selected]);
  useEffect(() => {
    if (!sidebar) return;
    navigationRef.current
      ?.querySelector<HTMLButtonElement>(
        'button[aria-label="Close navigation"]',
      )
      ?.focus();
    const viewport = window.matchMedia("(max-width: 760px)");
    const closeOnDesktop = () => {
      if (!viewport.matches) setSidebar(false);
    };
    viewport.addEventListener("change", closeOnDesktop);
    return () => {
      viewport.removeEventListener("change", closeOnDesktop);
      document.querySelector<HTMLButtonElement>(".mobile-nav-toggle")?.focus();
    };
  }, [sidebar]);
  const choose = (id: string) => {
    setSelected(id);
    setView("inbox");
    setSidebar(false);
    history.replaceState(null, "", id ? `/?ticket=${id}` : "/");
  };
  const navigate = (next: string) => {
    setView(next);
    setSelected("");
    setContactId("");
    setSidebar(false);
    history.replaceState(null, "", next === "inbox" ? "/" : `/?view=${next}`);
  };
  const selectContact = (id: string, inbox = inboxId) => {
    setContactId(id);
    const url = new URLSearchParams({ view: "contacts" });
    if (id) url.set("contact", id);
    if (inbox) url.set("inbox", inbox);
    history.replaceState(null, "", `/?${url}`);
  };
  if (me.error)
    return (
      <div className="access-screen">
        <div className="brand-icon">
          <LifeBuoy size={27} />
        </div>
        <h1>Sign in to Smart Inbox</h1>
        <p>{me.error}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  const connected = health.data?.mailboxes.some((m) => m.state === "connected");
  const folderLabel = folders.find((f) => f.id === status)!.label;
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="navigation-backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        id="main-navigation"
        ref={navigationRef}
        onKeyDown={(event) => {
          if (!sidebar) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setSidebar(false);
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "a[href], button, select",
            ),
          ).filter((item) => item.getBoundingClientRect().width > 0);
          const first = items[0],
            last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        className={`sidebar ${sidebar ? "visible" : ""}`}
      >
        <div className="sidebar-brand">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("inbox");
            }}
          >
            <span className="brand-icon">
              {workspace.logo ? (
                <img className="workspace-logo" src={workspace.logo} alt="" />
              ) : (
                <LifeBuoy size={18} />
              )}
            </span>
            <span>{workspace.name}</span>
          </a>
          <button
            className="mobile-menu icon-button"
            aria-label="Close navigation"
            onClick={() => setSidebar(false)}
          >
            <X size={20} />
          </button>
        </div>
        <button
          className="compose-nav"
          onClick={() => {
            setCompose(true);
            setSidebar(false);
          }}
        >
          <Plus size={16} /> New conversation
        </button>
        <label className="inbox-switcher">
          <span>Inbox</span>
          <select
            aria-label="Select inbox"
            value={inboxId}
            onChange={(e) => {
              setInboxId(e.target.value);
              setOffset(0);
              if (view === "contacts") selectContact(contactId, e.target.value);
              else if (view !== "reports") navigate("inbox");
            }}
          >
            <option value="">All inboxes</option>
            {inboxes.data?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Conversation status" className="folder-navigation">
          {folders.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === "inbox" && status === id ? "active" : ""}`}
              aria-current={
                view === "inbox" && status === id ? "page" : undefined
              }
              onClick={() => {
                setStatus(id);
                setOffset(0);
                navigate("inbox");
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
              <span className="nav-count">
                {folderCounts.data ? folderCounts.data[id] || 0 : "—"}
              </span>
            </button>
          ))}
          <button
            className={`nav-item ${view === "drafts" ? "active" : ""}`}
            aria-current={view === "drafts" ? "page" : undefined}
            onClick={() => navigate("drafts")}
          >
            <FilePenLine size={16} />
            <span>Drafts</span>
            <span className="nav-count">{drafts.data?.length || 0}</span>
          </button>
        </nav>
        <nav className="contacts-navigation" aria-label="Workspace">
          <button
            className={`nav-item ${view === "contacts" ? "active" : ""}`}
            aria-current={view === "contacts" ? "page" : undefined}
            onClick={() => navigate("contacts")}
          >
            <Users size={16} /> Contacts
          </button>
          <button
            className={`nav-item ${view === "reports" ? "active" : ""}`}
            aria-current={view === "reports" ? "page" : undefined}
            onClick={() => navigate("reports")}
          >
            <ChartNoAxesCombined size={16} /> Reports
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <SettingsIcon size={16} /> Settings
          </button>
          {workspace.documentation_url && (
            <a
              className="nav-item"
              href={workspace.documentation_url}
              target="_blank"
              rel="noreferrer"
            >
              <CircleHelp size={16} /> Documentation <ArrowUpRight size={13} />
            </a>
          )}
          <div className="owner">
            <span className="avatar">
              {initials(me.data?.email || "Owner")}
            </span>
            <span>
              Owner<small>{me.data?.email || "Signing in…"}</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main-area" inert={sidebar}>
        <button
          className="mobile-menu mobile-nav-toggle icon-button"
          aria-label="Open navigation"
          aria-expanded={sidebar}
          aria-controls="main-navigation"
          onClick={() => setSidebar(true)}
        >
          <Menu size={21} />
        </button>
        {view === "settings" ? (
          workspaceData.data ? (
            <Settings
              workspace={workspace}
              inboxes={inboxes.data || []}
              health={health.data}
              refresh={refresh}
              reload={reload}
              notify={notify}
            />
          ) : (
            <p role="status">{workspaceData.error || "Loading settings…"}</p>
          )
        ) : view === "reports" ? (
          <Suspense fallback={<p role="status">Loading reports…</p>}>
            <Reports
              key={workspace.timezone}
              inboxes={inboxes.data || []}
              inboxId={inboxId}
              setInboxId={setInboxId}
              timezone={workspace.timezone}
              openConversation={choose}
              notify={notify}
              openContact={(id) => {
                setView("contacts");
                selectContact(id);
              }}
            />
          </Suspense>
        ) : view === "contacts" ? (
          <Contacts
            refresh={refresh}
            reload={reload}
            inboxes={inboxes.data || []}
            inboxId={inboxId}
            setInboxId={(id) => {
              setInboxId(id);
              selectContact(contactId, id);
            }}
            contactId={contactId}
            selectContact={selectContact}
            openConversation={choose}
          />
        ) : view === "drafts" ? (
          <Drafts
            refresh={refresh}
            open={choose}
            compose={() => setCompose(true)}
            reload={reload}
            notify={notify}
          />
        ) : selected ? (
          <ConversationView
            key={selected}
            id={selected}
            refresh={refresh}
            inboxes={inboxes.data || []}
            reload={reload}
            onRead={refreshUnread}
            notify={notify}
            select={choose}
            openContact={(id) => {
              setView("contacts");
              selectContact(id);
            }}
            close={() => {
              returnToList.current = true;
              choose("");
              reload();
            }}
          />
        ) : (
          <section className="conversation-list" aria-labelledby="folder-title">
            <header className="list-toolbar">
              <h1 id="folder-title" tabIndex={-1}>
                {folderLabel}
              </h1>
              <div className="search-field">
                <Search size={18} />
                <input
                  aria-label="Search conversations"
                  placeholder="Search conversations…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    <X size={17} />
                  </button>
                )}
              </div>
            </header>
            {status === "trash" && (
              <div className="trash-description">
                Deleted conversations stay here until restored. Gmail copies are
                kept.
              </div>
            )}
            {selectionCount > 0 && (
              <div
                className="bulk-toolbar"
                role="group"
                aria-label="Actions for selected conversations"
                aria-busy={bulkBusy}
              >
                <strong aria-live="polite">{selectionCount} selected</strong>
                <div className="bulk-buttons">
                  {status === "trash" ? (
                    <button
                      className="button"
                      disabled={bulkBusy}
                      onClick={() => void bulkAction("restore")}
                    >
                      <RotateCcw size={16} /> Restore
                    </button>
                  ) : (
                    <>
                      <button
                        className="button"
                        disabled={bulkBusy}
                        onClick={() => void bulkAction("open")}
                      >
                        <InboxIcon size={16} /> Open
                      </button>
                      <button
                        className="button"
                        disabled={bulkBusy}
                        onClick={() => void bulkAction("waiting")}
                      >
                        <Clock3 size={16} /> Waiting
                      </button>
                      <button
                        className="button"
                        disabled={bulkBusy}
                        onClick={() => void bulkAction("closed")}
                      >
                        <Check size={16} /> Close
                      </button>
                      <button
                        className="button"
                        disabled={bulkBusy}
                        onClick={() => void bulkAction("read")}
                      >
                        <MailOpen size={16} /> Mark read
                      </button>
                      <button
                        className="button"
                        disabled={bulkBusy}
                        onClick={() => void bulkAction("unread")}
                      >
                        <Mail size={16} /> Mark unread
                      </button>
                      <button
                        className="button bulk-trash"
                        disabled={bulkBusy}
                        onClick={() => void bulkAction("trash")}
                      >
                        <Trash2 size={16} /> Move to Trash
                      </button>
                    </>
                  )}
                </div>
                <button
                  className="icon-button"
                  aria-label="Clear selection"
                  disabled={bulkBusy}
                  onClick={() => setChecked({})}
                >
                  <X size={18} />
                </button>
              </div>
            )}
            <div className="list-scroll">
              <div className="list-columns">
                <label className="selection-control">
                  <input
                    type="checkbox"
                    ref={selectAllRef}
                    aria-label="Select all conversations on this page"
                    checked={allChecked}
                    disabled={
                      bulkBusy ||
                      !list.data?.items.length ||
                      list.loading ||
                      query !== search
                    }
                    onChange={() =>
                      setChecked(
                        allChecked
                          ? {}
                          : Object.fromEntries(
                              (list.data?.items || []).map((c) => [
                                c.id,
                                c.revision,
                              ]),
                            ),
                      )
                    }
                  />
                </label>
                <span className="mobile-selection-label">Select page</span>
                <span>Customer</span>
                <span>Conversation</span>
                <span>Waiting</span>
                <span>Email</span>
              </div>
              {list.error && (
                <div className="inline-error" role="alert">
                  {list.error}
                </div>
              )}
              {list.loading && !list.data && (
                <div className="list-empty" role="status">
                  Loading conversations…
                </div>
              )}
              <ul className="conversation-rows">
                {list.data?.items.map((c) => (
                  <li
                    key={c.id}
                    className={`conversation-item ${checked[c.id] !== undefined ? "selected" : ""} ${c.unread ? "unread" : ""}`}
                  >
                    <label className="selection-control">
                      <input
                        type="checkbox"
                        aria-label={`Select conversation #${c.number}: ${c.subject}`}
                        checked={checked[c.id] !== undefined}
                        disabled={bulkBusy || list.loading || query !== search}
                        onChange={() =>
                          setChecked((current) => {
                            const next = { ...current };
                            if (next[c.id] !== undefined) delete next[c.id];
                            else next[c.id] = c.revision;
                            return next;
                          })
                        }
                      />
                    </label>
                    <a
                      href={`/?ticket=${c.id}`}
                      className="conversation-row"
                      onClick={(e) => {
                        if (
                          !e.metaKey &&
                          !e.ctrlKey &&
                          !e.shiftKey &&
                          !e.altKey
                        ) {
                          e.preventDefault();
                          choose(c.id);
                        }
                      }}
                    >
                      <span className="row-customer">
                        <span className={`avatar hue-${c.number % 4}`}>
                          {initials(c.contact_name)}
                        </span>
                        <span>
                          <strong title={c.contact_name}>
                            {c.contact_name}
                          </strong>
                        </span>
                      </span>
                      <span className="row-content">
                        <span
                          className="row-subject"
                          title={`${c.subject} · #${c.number} · ${c.inbox_name}`}
                        >
                          {!!c.unread && (
                            <span className="unread-dot">
                              <span className="sr-only">Unread: </span>
                            </span>
                          )}
                          {c.subject}
                        </span>
                        <span className="row-snippet">
                          {c.snippet || "No messages yet"}
                        </span>
                      </span>
                      <time
                        dateTime={new Date(c.updated_at).toISOString()}
                        title={`Last activity: ${dateTime(c.updated_at)}`}
                      >
                        {relative(c.updated_at)}
                      </time>
                      <span className="row-email" title={c.contact_email}>
                        {c.contact_email}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
              {!list.loading && !list.error && !list.data?.items.length && (
                <div className="list-empty">
                  <Mail size={30} />
                  <h2>
                    {search
                      ? "No matching conversations"
                      : `No ${status} conversations`}
                  </h2>
                  {search ? (
                    <p>Try a name, email address, ticket number, or keyword.</p>
                  ) : (
                    !connected && (
                      <button
                        className="button primary"
                        onClick={() => navigate("settings")}
                      >
                        <Plus size={17} /> Connect a mailbox
                      </button>
                    )
                  )}
                </div>
              )}
              {list.data && !!list.data.items.length && (
                <div className="list-caption">
                  {offset + 1}–{offset + list.data.items.length}
                  {list.data.has_more
                    ? " · More conversations available"
                    : ` of ${offset + list.data.items.length}`}{" "}
                  · Newest first
                </div>
              )}
              {(offset > 0 || list.data?.has_more) && (
                <div className="pagination">
                  <button
                    className="button"
                    disabled={!offset || bulkBusy}
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    Previous
                  </button>
                  <button
                    className="button"
                    disabled={!list.data?.has_more || bulkBusy}
                    onClick={() => setOffset(offset + 50)}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
      {compose && (
        <dialog
          ref={composeDialog}
          className="compose-modal"
          onCancel={(e) => {
            e.preventDefault();
            setCompose(false);
          }}
          aria-labelledby="compose-title"
        >
          <header>
            <h2 id="compose-title">New conversation</h2>
            <button
              className="icon-button"
              aria-label="Close composer"
              onClick={() => setCompose(false)}
            >
              <X size={21} />
            </button>
          </header>
          <Composer
            inboxes={inboxes.data || []}
            onSent={(id) => {
              setCompose(false);
              choose(id);
              reload();
            }}
            notify={notify}
          />
        </dialog>
      )}
      {toast && <Toast notice={toast} dismiss={() => setToast(null)} />}
    </div>
  );
}
