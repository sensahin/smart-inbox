export type Timing = {
  count: number;
  average: number | null;
  median: number | null;
  p90: number | null;
};
export type ReportMetrics = {
  active: number;
  created: number;
  received: number;
  sent: number;
  customers: number;
  helped: number;
  resolved: number;
  one_reply_percent: number | null;
  first_response: Timing;
  response: Timing;
  resolution: Timing;
};
export type ReportDay = {
  date: string;
  created: number;
  received: number;
  sent: number;
  resolved: number;
  first_response: Timing;
  response: Timing;
  resolution: Timing;
};
export type ReportConversation = {
  id: string;
  number: number;
  subject: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  inbox_name: string;
  status: string;
  created_at: number;
  is_new: boolean;
  received: number;
  sent: number;
  first_response_ms: number | null;
  response_ms: number | null;
  response_count: number;
  resolved_at: number | null;
  resolution_ms: number | null;
};
export type ReportFilter =
  | "active"
  | "created"
  | "received"
  | "sent"
  | "resolved"
  | "first_response"
  | "response";
export type Report = {
  from: string;
  to: string;
  previous_from: string;
  previous_to: string;
  timezone: string;
  generated_at: number;
  reporting_started_at: number | null;
  partial_day: boolean;
  coverage_incomplete: boolean;
  metrics: ReportMetrics;
  previous: ReportMetrics;
  days: ReportDay[];
  heatmap: number[][];
  distribution: { label: string; count: number }[];
  customers: {
    id: string;
    name: string;
    email: string;
    conversations: number;
    received: number;
  }[];
  inboxes: {
    id: string;
    name: string;
    created: number;
    received: number;
    sent: number;
    resolved: number;
  }[];
  backlog: { open: number; waiting: number };
};

export const reportDefinitions = {
  active:
    "Conversations created, emailed, or changed status during this period. Trash and automatic acknowledgements are excluded.",
  created:
    "Conversations created during this period, including conversations you started.",
  received:
    "Incoming messages received during this period. Multiple messages in one conversation count separately.",
  sent: "Accepted outgoing emails during this period, including new emails and forwards. Automatic acknowledgements and unsent drafts are excluded.",
  customers:
    "Distinct contacts who sent an incoming message during this period.",
  helped:
    "Distinct contacts who received a reply during this period. New emails, forwards, and automatic acknowledgements are excluded.",
  first_response:
    "Time from the first incoming message to the first reply, for first replies sent during this period. Incomplete history and conversations you started are excluded.",
  response:
    "Time from the earliest unanswered incoming message to your next reply, for replies sent during this period. Consecutive outgoing messages do not start another timer. Forwards and automatic acknowledgements do not answer a customer.",
  resolved:
    "Currently closed conversations with a customer reply and a recorded latest closure in this period. Reopening removes a resolution until the conversation is closed again.",
  resolution:
    "Time from conversation creation to its latest recorded closure, for resolved conversations in this period. Incomplete history is excluded.",
  one_reply_percent:
    "Share of resolved conversations with complete history that have exactly one customer reply sent by you. Forwards and automatic acknowledgements are excluded.",
} satisfies Record<keyof ReportMetrics, string>;

export function reportDate(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  return ["year", "month", "day"]
    .map((key) => parts.find((p) => p.type === key)!.value)
    .join("-");
}
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function durationLabel(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  if (ms < 86400000)
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h`;
}
