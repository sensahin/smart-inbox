import type {
  ReportConversation,
  ReportDay,
  ReportMetrics,
  Timing,
} from "../shared/reports";
import { reportDate, shiftDate } from "../shared/reports";

export type ReportTicket = {
  id: string;
  number: number;
  subject: string;
  inbox_id: string;
  inbox_name: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  status: string;
  history_missing: number;
  created_at: number;
  closed_at: number | null;
};
export type ReportMessage = {
  id: string;
  conversation_id: string;
  direction: string;
  sent_at: number;
  kind: string | null;
  recipients: string;
  cc: string;
};
export type ReportStatusEvent = { conversation_id: string; changed_at: number };

export function timing(values: number[]): Timing {
  if (!values.length)
    return { count: 0, average: null, median: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    average: Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length),
    median:
      sorted.length % 2
        ? sorted[mid]
        : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
}

/** Find the first instant of a local date, including midnight offset changes. */
export function startOfDate(date: string, timezone: string): number {
  const utc = Date.parse(date + "T00:00:00Z");
  let low = utc - 36 * 3600000,
    high = utc + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (reportDate(mid, timezone) < date) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function reportPeriod(from: string, to: string, timezone: string) {
  const count = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const previous_from = shiftDate(from, -count),
    previous_to = shiftDate(from, -1);
  return {
    from,
    to,
    previous_from,
    previous_to,
    start: startOfDate(from, timezone),
    end: startOfDate(shiftDate(to, 1), timezone),
    previous_start: startOfDate(previous_from, timezone),
  };
}

type Samples = { first: number[]; response: number[]; resolution: number[] };
function addressedTo(message: ReportMessage, email: string): boolean {
  try {
    return [...JSON.parse(message.recipients), ...JSON.parse(message.cc)].some(
      (recipient) =>
        typeof recipient === "string" &&
        recipient.toLowerCase() === email.toLowerCase(),
    );
  } catch {
    return false;
  }
}

export function aggregatePeriod(
  tickets: ReportTicket[],
  messages: ReportMessage[],
  events: ReportStatusEvent[],
  from: string,
  to: string,
  start: number,
  end: number,
  timezone: string,
) {
  const contains = (at: number) => at >= start && at < end;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = (at: number) => {
    const p = formatter.formatToParts(at),
      get = (type: string) => p.find((v) => v.type === type)!.value;
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      hour: Number(get("hour")),
    };
  };
  const samples: Samples = { first: [], response: [], resolution: [] };
  const metrics: ReportMetrics = {
    active: 0,
    created: 0,
    received: 0,
    sent: 0,
    customers: 0,
    helped: 0,
    resolved: 0,
    one_reply_percent: null,
    first_response: timing([]),
    response: timing([]),
    resolution: timing([]),
  };
  const days = new Map<string, ReportDay & { samples: Samples }>();
  for (let date = from; date <= to; date = shiftDate(date, 1))
    days.set(date, {
      date,
      created: 0,
      received: 0,
      sent: 0,
      resolved: 0,
      first_response: timing([]),
      response: timing([]),
      resolution: timing([]),
      samples: { first: [], response: [], resolution: [] },
    });
  const byTicket = new Map<string, ReportMessage[]>();
  // SQL supplies stable ordering; also sort here so ingestion/reconciliation order cannot affect timers.
  for (const m of messages) {
    if (m.direction === "auto") continue;
    const list = byTicket.get(m.conversation_id) || [];
    list.push(m);
    byTicket.set(m.conversation_id, list);
  }
  const statusActivity = new Set(
    events.filter((e) => contains(e.changed_at)).map((e) => e.conversation_id),
  );
  const customers = new Map<
    string,
    {
      id: string;
      name: string;
      email: string;
      conversations: number;
      received: number;
    }
  >();
  const helped = new Set<string>();
  const inboxes = new Map<
    string,
    {
      id: string;
      name: string;
      created: number;
      received: number;
      sent: number;
      resolved: number;
    }
  >();
  const rows: ReportConversation[] = [],
    heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  let completeResolved = 0,
    oneReply = 0;
  for (const c of tickets) {
    const thread = (byTicket.get(c.id) || []).sort(
      (a, b) =>
        a.sent_at - b.sent_at ||
        (a.direction === b.direction
          ? a.id.localeCompare(b.id)
          : a.direction === "inbound"
            ? -1
            : 1),
    );
    const row: ReportConversation = {
      id: c.id,
      number: c.number,
      subject: c.subject,
      contact_id: c.contact_id,
      contact_name: c.contact_name,
      contact_email: c.contact_email,
      inbox_name: c.inbox_name,
      status: c.status,
      created_at: c.created_at,
      is_new: contains(c.created_at),
      received: 0,
      sent: 0,
      first_response_ms: null,
      response_ms: null,
      response_count: 0,
      resolved_at: null,
      resolution_ms: null,
    };
    const rowResponses: number[] = [];
    let pending: number | null = null,
      hasInbound = false,
      hasReply = false,
      repliesToClose = 0;
    const eligibleFirst =
      !c.history_missing && thread[0]?.direction === "inbound";
    for (const m of thread) {
      if (m.sent_at >= end) break;
      const inPeriod = contains(m.sent_at),
        local = inPeriod ? parts(m.sent_at) : null;
      const day = local ? days.get(local.date) : undefined;
      if (m.direction === "inbound") {
        hasInbound = true;
        pending ??= m.sent_at;
        if (inPeriod) {
          row.received++;
          if (day) day.received++;
          const weekday =
            (new Date(local!.date + "T12:00:00Z").getUTCDay() + 6) % 7;
          heatmap[weekday][local!.hour]++;
        }
      } else if (m.direction === "outbound") {
        if (inPeriod) {
          row.sent++;
          if (day) day.sent++;
        }
        const isReply =
          m.kind !== "forward" &&
          m.kind !== "new" &&
          hasInbound &&
          addressedTo(m, c.contact_email);
        if (!isReply) continue;
        if (c.closed_at !== null && m.sent_at <= c.closed_at) repliesToClose++;
        if (inPeriod) helped.add(c.contact_id);
        if (pending !== null) {
          const elapsed = m.sent_at - pending;
          if (inPeriod) {
            samples.response.push(elapsed);
            rowResponses.push(elapsed);
            day?.samples.response.push(elapsed);
            if (!hasReply && eligibleFirst) {
              row.first_response_ms = elapsed;
              samples.first.push(elapsed);
              day?.samples.first.push(elapsed);
            }
          }
          pending = null;
        }
        hasReply = true;
      }
    }
    row.response_count = rowResponses.length;
    row.response_ms = timing(rowResponses).average;
    if (
      c.status === "closed" &&
      c.closed_at !== null &&
      contains(c.closed_at) &&
      repliesToClose > 0
    ) {
      row.resolved_at = c.closed_at;
      metrics.resolved++;
      const day = days.get(parts(c.closed_at).date);
      if (day) day.resolved++;
      if (!c.history_missing && c.closed_at >= c.created_at) {
        completeResolved++;
        if (repliesToClose === 1) oneReply++;
        row.resolution_ms = c.closed_at - c.created_at;
        samples.resolution.push(row.resolution_ms);
        day?.samples.resolution.push(row.resolution_ms);
      }
    }
    if (
      !row.is_new &&
      !row.received &&
      !row.sent &&
      !row.resolved_at &&
      !statusActivity.has(c.id)
    )
      continue;
    rows.push(row);
    metrics.active++;
    if (row.is_new) {
      metrics.created++;
      const day = days.get(parts(c.created_at).date);
      if (day) day.created++;
    }
    metrics.received += row.received;
    metrics.sent += row.sent;
    if (row.received) {
      const customer = customers.get(c.contact_id) || {
        id: c.contact_id,
        name: c.contact_name,
        email: c.contact_email,
        conversations: 0,
        received: 0,
      };
      customer.conversations++;
      customer.received += row.received;
      customers.set(c.contact_id, customer);
    }
    const inbox = inboxes.get(c.inbox_id) || {
      id: c.inbox_id,
      name: c.inbox_name,
      created: 0,
      received: 0,
      sent: 0,
      resolved: 0,
    };
    inbox.created += Number(row.is_new);
    inbox.received += row.received;
    inbox.sent += row.sent;
    inbox.resolved += Number(row.resolved_at !== null);
    inboxes.set(c.inbox_id, inbox);
  }
  metrics.customers = customers.size;
  metrics.helped = helped.size;
  metrics.first_response = timing(samples.first);
  metrics.response = timing(samples.response);
  metrics.resolution = timing(samples.resolution);
  metrics.one_reply_percent = completeResolved
    ? Math.round((oneReply / completeResolved) * 1000) / 10
    : null;
  const limits = [
    15 * 60000,
    30 * 60000,
    3600000,
    2 * 3600000,
    6 * 3600000,
    12 * 3600000,
    86400000,
    Infinity,
  ];
  const labels = [
    "Under 15 minutes",
    "15–30 minutes",
    "30–60 minutes",
    "1–2 hours",
    "2–6 hours",
    "6–12 hours",
    "12–24 hours",
    "1 day or more",
  ];
  return {
    metrics,
    rows,
    heatmap,
    distribution: labels.map((label, i) => ({
      label,
      count: samples.response.filter(
        (n) => n >= (limits[i - 1] || 0) && n < limits[i],
      ).length,
    })),
    days: [...days.values()].map(({ samples: s, ...day }) => ({
      ...day,
      first_response: timing(s.first),
      response: timing(s.response),
      resolution: timing(s.resolution),
    })),
    customers: [...customers.values()]
      .sort(
        (a, b) =>
          b.conversations - a.conversations ||
          b.received - a.received ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 10),
    inboxes: [...inboxes.values()].sort(
      (a, b) => b.received - a.received || a.name.localeCompare(b.name),
    ),
  };
}

export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  // Neutralize spreadsheet formulas, including prefixes hidden behind whitespace/control characters.
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
