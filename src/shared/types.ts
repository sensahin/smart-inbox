export type Status = "open" | "waiting" | "closed";
export type Folder = Status | "trash";
export type BulkAction = Status | "read" | "unread" | "trash" | "restore";
export interface BulkResult {
  updated: string[];
  skipped: { id: string; reason: string }[];
}
export interface Mailbox {
  id: string;
  email: string;
  aliases: string;
  history_id: string;
  cutover_at: number;
  state: string;
  last_sync_at: number | null;
  error: string | null;
  created_at: number;
}
export interface Inbox {
  id: string;
  mailbox_id: string | null;
  name: string;
  address: string;
  from_name: string;
  signature: string;
  signature_aliases: number;
  default_status: Status;
  auto_bcc: string;
  auto_reply: string;
  auto_reply_mode: "always" | "outside_hours" | "off";
  timezone: string;
  office_start: number;
  office_end: number;
  routing_priority: number;
  created_at: number;
}
export interface Contact {
  id: string;
  email: string;
  name: string;
  freemius_email: string | null;
  created_at: number;
}
export interface ContactSummary {
  id: string;
  email: string;
  name: string;
  created_at: number;
  conversation_count: number;
  last_activity_at: number | null;
}
export interface ContactsResult {
  items: ContactSummary[];
  total: number;
  has_more: boolean;
}
export interface ContactHistory {
  contact: ContactSummary;
  items: Conversation[];
  has_more: boolean;
}
export interface Conversation {
  id: string;
  number: number;
  inbox_id: string;
  contact_id: string;
  mailbox_id: string | null;
  gmail_thread_id: string | null;
  subject: string;
  status: Status;
  unread: number;
  history_missing: number;
  deleted_at: number | null;
  revision: number;
  last_inbound_id: string | null;
  snippet: string;
  created_at: number;
  updated_at: number;
  contact_name: string;
  contact_email: string;
  inbox_name: string;
}
export interface Attachment {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
  created_at: number;
}
export interface Message {
  open_tracked?: number;
  first_opened_at?: number | null;
  id: string;
  conversation_id: string;
  mailbox_id: string;
  gmail_id: string | null;
  gmail_thread_id: string | null;
  rfc_message_id: string | null;
  direction: "inbound" | "outbound" | "auto";
  sender: string;
  sender_name: string;
  recipients: string;
  cc: string;
  subject: string;
  body_key: string;
  search_text: string;
  headers: string;
  sent_at: number;
  html?: string;
  text?: string;
  attachments?: Attachment[];
}
export interface ComposePayload {
  inbox_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  attachment_ids: string[];
  kind: "new" | "reply" | "forward" | "auto";
  status: Status;
  conversation_id?: string;
  draft_id?: string;
  draft_version?: number;
  idempotency_key: string;
}
export interface Outgoing {
  id: string;
  conversation_id: string;
  mailbox_id: string;
  message_id: string;
  kind: ComposePayload["kind"];
  payload: string;
  state: "pending" | "sending" | "sent" | "uncertain" | "failed";
  desired_status: Status;
  last_inbound_id: string | null;
  gmail_id: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export interface SavedReply {
  id: string;
  title: string;
  body: string;
  updated_at: number;
}
export interface Draft {
  id: string;
  payload: string;
  version: number;
  updated_at: number;
}
export interface ProviderResult {
  state: "matched" | "not_found" | "unconfigured" | "error";
  fetched_at: number;
  error?: string;
  html?: string;
  data?: Record<string, unknown>;
}
export interface Health {
  open_tracking_enabled: boolean;
  open_tracking_available: boolean;
  sending_enabled: boolean;
  acknowledgements_enabled: boolean;
  restore_reconciled: boolean;
  mailboxes: Mailbox[];
  jobs: Outgoing[];
  backup_error: string;
  backup: { at: number; key: string } | null;
  configured: Record<string, boolean>;
}
export const DEFAULT_ACK = `Hello {{customer.firstName|there}},\n\nWe received your request. Someone from our team will get back to you as soon as possible.\n\nThank you!\n{{inbox.name}}`;
