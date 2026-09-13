import { useEffect, useState, type MouseEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Search,
  Users,
  X,
} from "lucide-react";
import type { ContactHistory, ContactsResult, Inbox } from "../shared/types";
import { dateTime, initials, relative, useResource } from "./api";
import { CustomerBadge } from "./CustomerCards";
import "./Contacts.css";

type Sort = "name" | "email" | "conversation_count" | "last_activity_at";
const columns: { key: Sort; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "conversation_count", label: "Conversations" },
  { key: "last_activity_at", label: "Last activity" },
];
// Preserve standard link behavior for opening profiles and conversations in another tab.
function follow(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (
    event.button ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  action();
}

export function Contacts({
  refresh,
  reload,
  inboxes,
  inboxId,
  setInboxId,
  contactId,
  selectContact,
  openConversation,
}: {
  refresh: number;
  reload: () => void;
  inboxes: Inbox[];
  inboxId: string;
  setInboxId: (id: string) => void;
  contactId: string;
  selectContact: (id: string) => void;
  openConversation: (id: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("last_activity_at");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setOffset(0);
    setHistoryOffset(0);
  }, [inboxId]);
  useEffect(() => {
    setHistoryOffset(0);
  }, [contactId]);
  const inboxQuery = `inbox=${encodeURIComponent(inboxId)}`;
  const directory = useResource<ContactsResult>(
    contactId
      ? null
      : `/contacts?${inboxQuery}&q=${encodeURIComponent(search)}&sort=${sort}&direction=${direction}&offset=${offset}`,
    refresh,
  );
  const history = useResource<ContactHistory>(
    contactId
      ? `/contacts/${encodeURIComponent(contactId)}?${inboxQuery}&offset=${historyOffset}`
      : null,
    refresh,
  );
  const contact = history.data?.contact;
  const active = contactId ? history : directory;
  const total = contactId ? contact?.conversation_count : directory.data?.total;
  const currentOffset = contactId ? historyOffset : offset;
  const setPage = contactId ? setHistoryOffset : setOffset;
  const items = active.data?.items;
  const profileUrl = (id: string) =>
    `/?view=contacts&contact=${encodeURIComponent(id)}${inboxId ? `&${inboxQuery}` : ""}`;

  function changeSort(next: Sort) {
    setDirection(
      next === sort
        ? direction === "asc"
          ? "desc"
          : "asc"
        : next === "name" || next === "email"
          ? "asc"
          : "desc",
    );
    setSort(next);
    setOffset(0);
  }

  return (
    <section
      className="contacts-page conversation-list"
      aria-labelledby="contacts-title"
    >
      <header className="list-toolbar">
        {contactId ? (
          <nav className="contact-breadcrumb" aria-label="Contact navigation">
            <a
              href={`/?view=contacts${inboxId ? `&${inboxQuery}` : ""}`}
              onClick={(event) => follow(event, () => selectContact(""))}
            >
              Contacts
            </a>
            <ChevronRight size={15} aria-hidden="true" />
            <h1 id="contacts-title" title={contact?.name}>
              {contact?.name || "Contact"}
            </h1>
          </nav>
        ) : (
          <h1 id="contacts-title">
            Contacts{" "}
            <span className="count-badge">
              {directory.data?.total.toLocaleString() ?? "—"}
            </span>
          </h1>
        )}
      </header>
      <div className="contacts-filters">
        {!contactId && (
          <div className="search-field">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="Search contacts"
              placeholder="Search name or email…"
              maxLength={150}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                aria-label="Clear contact search"
                onClick={() => setQuery("")}
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <select
          aria-label="Filter contacts by inbox"
          value={inboxId}
          onChange={(event) => setInboxId(event.target.value)}
        >
          <option value="">All inboxes</option>
          {inboxes.map((inbox) => (
            <option value={inbox.id} key={inbox.id}>
              {inbox.name}
            </option>
          ))}
        </select>
      </div>
      {contact && (
        <div className="contact-overview">
          <span className="avatar small hue-1" aria-hidden="true">
            {initials(contact.name)}
          </span>
          <div>
            <strong>{contact.name}</strong>
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </div>
          <span className="muted">
            {contact.conversation_count.toLocaleString()} conversation
            {contact.conversation_count === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {active.error && (
        <div className="contacts-error" role="alert">
          <p>{active.error}</p>
          <button className="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      <div className="list-scroll" aria-busy={active.loading}>
        {!active.data && !active.error && (
          <p className="contacts-loading" role="status">
            Loading {contactId ? "conversations" : "contacts"}…
          </p>
        )}
        {items && items.length > 0 && (
          <div className="contacts-table-scroll">
            {contactId ? (
              <table className="contacts-table contact-history-table">
                <caption className="sr-only">
                  Conversations with {contact?.name}, including Trash
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Conversation</th>
                    <th scope="col">Inbox</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data?.items.map((conversation) => (
                    <tr key={conversation.id}>
                      <td>
                        <a
                          className="contact-conversation-link"
                          href={`/?ticket=${encodeURIComponent(conversation.id)}`}
                          onClick={(event) =>
                            follow(event, () =>
                              openConversation(conversation.id),
                            )
                          }
                        >
                          <strong title={conversation.subject}>
                            {conversation.subject}
                          </strong>
                          <span>
                            #{conversation.number}
                            {conversation.snippet
                              ? ` · ${conversation.snippet}`
                              : ""}
                          </span>
                        </a>
                      </td>
                      <td>
                        <span
                          className="contact-cell-text"
                          title={conversation.inbox_name}
                        >
                          {conversation.inbox_name}
                        </span>
                      </td>
                      <td>
                        <CustomerBadge
                          tone={conversation.deleted_at ? "neutral" : undefined}
                        >
                          {conversation.deleted_at
                            ? "Trash"
                            : conversation.status}
                        </CustomerBadge>
                      </td>
                      <td>
                        <ActivityTime value={conversation.updated_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="contacts-table">
                <caption className="sr-only">
                  Contacts and their email conversation activity
                </caption>
                <thead>
                  <tr>
                    {columns.map(({ key, label }) => (
                      <th
                        key={key}
                        scope="col"
                        aria-sort={
                          sort === key
                            ? direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          className={
                            sort === key
                              ? "contact-sort active"
                              : "contact-sort"
                          }
                          onClick={() => changeSort(key)}
                        >
                          {label}
                          {sort === key ? (
                            direction === "asc" ? (
                              <ArrowUp size={13} />
                            ) : (
                              <ArrowDown size={13} />
                            )
                          ) : (
                            <ArrowUpDown size={13} />
                          )}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {directory.data?.items.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <a
                          className="contact-name-link"
                          href={profileUrl(entry.id)}
                          onClick={(event) =>
                            follow(event, () => selectContact(entry.id))
                          }
                        >
                          <span
                            className="avatar small hue-1"
                            aria-hidden="true"
                          >
                            {initials(entry.name)}
                          </span>
                          <strong title={entry.name}>{entry.name}</strong>
                        </a>
                      </td>
                      <td>
                        <a
                          className="contact-cell-text"
                          title={entry.email}
                          href={profileUrl(entry.id)}
                          onClick={(event) =>
                            follow(event, () => selectContact(entry.id))
                          }
                        >
                          {entry.email}
                        </a>
                      </td>
                      <td>
                        <a
                          className="count-badge"
                          aria-label={`${entry.conversation_count} conversation${entry.conversation_count === 1 ? "" : "s"} with ${entry.name}`}
                          href={profileUrl(entry.id)}
                          onClick={(event) =>
                            follow(event, () => selectContact(entry.id))
                          }
                        >
                          {entry.conversation_count.toLocaleString()}
                        </a>
                      </td>
                      <td>
                        <ActivityTime value={entry.last_activity_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {items?.length === 0 && !active.error && (
          <div className="empty-state">
            <Users size={28} aria-hidden="true" />
            <h2>
              {contactId
                ? "No conversations in this inbox"
                : search || inboxId
                  ? "No matching contacts"
                  : "No contacts yet"}
            </h2>
            <p>
              {contactId
                ? "Choose another inbox to view this contact’s history."
                : search || inboxId
                  ? "Try another name, email address, or inbox."
                  : "Contacts are saved automatically when email arrives."}
            </p>
          </div>
        )}
      </div>
      {total !== undefined && (
        <footer className="pagination contacts-pagination">
          <span>
            {total
              ? `${currentOffset + 1}–${Math.min(currentOffset + 50, total)} of ${total.toLocaleString()}`
              : "0"}{" "}
            {contactId
              ? total === 1
                ? "conversation"
                : "conversations"
              : total === 1
                ? "contact"
                : "contacts"}
          </span>
          <div>
            <button
              className="button"
              disabled={!currentOffset || active.loading || !!active.error}
              onClick={() => setPage(Math.max(0, currentOffset - 50))}
            >
              Previous
            </button>
            <button
              className="button"
              disabled={
                !active.data?.has_more || active.loading || !!active.error
              }
              onClick={() => setPage(currentOffset + 50)}
            >
              Next
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

function ActivityTime({ value }: { value: number | null }) {
  return value === null ? (
    <span className="muted">—</span>
  ) : (
    <time dateTime={new Date(value).toISOString()} title={dateTime(value)}>
      {relative(value)}
    </time>
  );
}
