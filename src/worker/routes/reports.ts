import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../env";
import { AppError } from "../db";
import { workspaceSettings } from "../workspace";
import {
  aggregatePeriod,
  csvCell,
  reportPeriod,
  type ReportTicket,
  type ReportMessage,
  type ReportStatusEvent,
} from "../reporting";
import {
  reportDate,
  type Report,
  type ReportConversation,
  type ReportFilter,
} from "../../shared/reports";

export const reportRoutes = new Hono<Bindings>();
const date = z
  .string()
  .regex(/^20\d\d-\d{2}-\d{2}$/)
  .refine((s) => {
    const at = Date.parse(s + "T00:00:00Z");
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === s;
  }, "Use a valid calendar date.");
const querySchema = z
  .object({
    from: date,
    to: date,
    inbox: z.string().max(160).default(""),
    filter: z
      .enum([
        "active",
        "created",
        "received",
        "sent",
        "resolved",
        "first_response",
        "response",
      ])
      .default("active"),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    format: z.enum(["daily", "conversations"]).default("daily"),
  })
  .refine(
    (q) =>
      q.to >= q.from && Date.parse(q.to) - Date.parse(q.from) < 366 * 86400000,
    "Choose a range of 1 to 366 days.",
  );

async function calculate(env: AppEnv, input: Record<string, string>) {
  const q = querySchema.parse(input),
    workspace = await workspaceSettings(env),
    timezone = workspace.timezone;
  const generated_at = Date.now(),
    today = reportDate(generated_at, timezone);
  if (q.to > today)
    throw new AppError(400, "The report end date cannot be in the future.");
  const period = reportPeriod(q.from, q.to, timezone);
  const end = Math.min(period.end, generated_at + 1);
  const inboxClause = q.inbox ? " AND c.inbox_id=?" : "";
  const scope = `WITH selected AS (
    SELECT c.id FROM conversations c WHERE c.deleted_at IS NULL${inboxClause} AND (
      (c.created_at>=? AND c.created_at<?) OR
      EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.direction<>'auto' AND m.sent_at>=? AND m.sent_at<?) OR
      EXISTS (SELECT 1 FROM conversation_status_events e WHERE e.conversation_id=c.id AND e.changed_at>=? AND e.changed_at<?)
    ) LIMIT 10001
  )`;
  const values = [
    ...(q.inbox ? [q.inbox] : []),
    period.previous_start,
    end,
    period.previous_start,
    end,
    period.previous_start,
    end,
  ];
  // A single batch keeps the ledger, messages, current state, and coverage marker consistent.
  // Fetch metadata only; bodies, attachments, credentials, and provider lookups are unnecessary.
  const results = await env.DB.batch([
    env.DB.prepare(
      `${scope} SELECT c.id,c.number,c.subject,c.inbox_id,i.name inbox_name,c.contact_id,p.name contact_name,p.email contact_email,c.status,c.history_missing,c.created_at,
      (SELECT MAX(changed_at) FROM conversation_status_events WHERE conversation_id=c.id AND to_status='closed') closed_at
      FROM selected s JOIN conversations c ON c.id=s.id JOIN contacts p ON p.id=c.contact_id JOIN inboxes i ON i.id=c.inbox_id`,
    ).bind(...values),
    env.DB.prepare(
      `${scope} SELECT m.id,m.conversation_id,m.direction,m.sent_at,m.recipients,m.cc,
      (SELECT o.kind FROM outgoing o WHERE o.message_id=m.rfc_message_id AND o.mailbox_id=m.mailbox_id LIMIT 1) kind
      FROM selected s JOIN messages m ON m.conversation_id=s.id WHERE m.direction<>'auto' AND m.sent_at<? LIMIT 100001`,
    ).bind(...values, end),
    env.DB.prepare(
      `${scope} SELECT e.conversation_id,e.changed_at FROM selected s JOIN conversation_status_events e ON e.conversation_id=s.id WHERE e.changed_at>=? AND e.changed_at<? LIMIT 50001`,
    ).bind(...values, period.previous_start, end),
    env.DB.prepare(
      `SELECT COALESCE(SUM(status='open'),0) open,COALESCE(SUM(status='waiting'),0) waiting FROM conversations c WHERE deleted_at IS NULL${inboxClause}`,
    ).bind(...(q.inbox ? [q.inbox] : [])),
    env.DB.prepare(
      "SELECT value FROM settings WHERE key='reporting_started_at'",
    ),
  ]);
  if (
    results[0].results.length > 10000 ||
    results[1].results.length > 100000 ||
    results[2].results.length > 50000
  )
    throw new AppError(
      413,
      "This report contains too much activity. Choose a shorter date range or a single inbox.",
    );
  const tickets = results[0].results as ReportTicket[],
    messages = results[1].results as ReportMessage[],
    events = results[2].results as ReportStatusEvent[];
  const current = aggregatePeriod(
    tickets,
    messages,
    events,
    q.from,
    q.to,
    period.start,
    end,
    timezone,
  );
  const previous = aggregatePeriod(
    tickets,
    messages,
    events,
    period.previous_from,
    period.previous_to,
    period.previous_start,
    period.start,
    timezone,
  );
  const started =
    Number((results[4].results[0] as { value?: string } | undefined)?.value) ||
    null;
  const report: Report = {
    from: q.from,
    to: q.to,
    previous_from: period.previous_from,
    previous_to: period.previous_to,
    timezone,
    generated_at,
    reporting_started_at: started,
    partial_day: q.to === today,
    coverage_incomplete: !started || period.previous_start < started,
    metrics: current.metrics,
    previous: previous.metrics,
    days: current.days,
    heatmap: current.heatmap,
    distribution: current.distribution,
    customers: current.customers,
    inboxes: current.inboxes,
    backlog: results[3].results[0] as Report["backlog"],
  };
  return { q, report, rows: current.rows };
}

export function filterReportRows(
  rows: ReportConversation[],
  filter: ReportFilter,
) {
  return rows
    .filter((r) =>
      filter === "created"
        ? r.is_new
        : filter === "received"
          ? r.received > 0
          : filter === "sent"
            ? r.sent > 0
            : filter === "resolved"
              ? r.resolved_at !== null
              : filter === "first_response"
                ? r.first_response_ms !== null
                : filter === "response"
                  ? r.response_count > 0
                  : true,
    )
    .sort((a, b) =>
      filter === "response"
        ? (b.response_ms || 0) - (a.response_ms || 0) || b.number - a.number
        : filter === "first_response"
          ? (b.first_response_ms || 0) - (a.first_response_ms || 0) ||
            b.number - a.number
          : b.number - a.number,
    );
}
reportRoutes.get("/reports", async (c) =>
  c.json((await calculate(c.env, c.req.query())).report),
);
reportRoutes.get("/reports/conversations", async (c) => {
  const { q, rows } = await calculate(c.env, c.req.query()),
    filtered = filterReportRows(rows, q.filter);
  return c.json({
    items: filtered.slice(q.offset, q.offset + 50),
    total: filtered.length,
    has_more: filtered.length > q.offset + 50,
  });
});
reportRoutes.get("/reports/export", async (c) => {
  const { q, report, rows } = await calculate(c.env, c.req.query());
  const seconds = (n: number | null) =>
    n === null ? null : Math.round(n / 1000);
  const table: (string | number | null)[][] =
    q.format === "daily"
      ? [
          [
            "Date",
            "Time zone",
            "New conversations",
            "Messages received",
            "Emails sent",
            "Resolved",
            "First response average (seconds)",
            "First response samples",
            "Response average (seconds)",
            "Response samples",
            "Resolution average (seconds)",
            "Resolution samples",
            "Resolution tracking started (UTC)",
          ],
          ...report.days.map((d) => [
            d.date,
            report.timezone,
            d.created,
            d.received,
            d.sent,
            d.resolved,
            seconds(d.first_response.average),
            d.first_response.count,
            seconds(d.response.average),
            d.response.count,
            seconds(d.resolution.average),
            d.resolution.count,
            report.reporting_started_at === null
              ? "Unknown"
              : new Date(report.reporting_started_at).toISOString(),
          ]),
        ]
      : [
          [
            "Ticket",
            "Subject",
            "Customer",
            "Email",
            "Inbox",
            "Current status",
            "New in period",
            "Messages received",
            "Emails sent",
            "First response (seconds)",
            "Response average (seconds)",
            "Response samples",
            "Resolved at (UTC)",
            "Resolution (seconds)",
            "Period from",
            "Period to",
            "Time zone",
          ],
          ...filterReportRows(rows, q.filter).map((r) => [
            r.number,
            r.subject,
            r.contact_name,
            r.contact_email,
            r.inbox_name,
            r.status,
            r.is_new ? "Yes" : "No",
            r.received,
            r.sent,
            seconds(r.first_response_ms),
            seconds(r.response_ms),
            r.response_count,
            r.resolved_at === null
              ? null
              : new Date(r.resolved_at).toISOString(),
            seconds(r.resolution_ms),
            q.from,
            q.to,
            report.timezone,
          ]),
        ];
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="smart-inbox-${q.format}-${q.from}-${q.to}.csv"`,
  );
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(
    "\uFEFF" +
      table.map((row) => row.map(csvCell).join(",")).join("\r\n") +
      "\r\n",
  );
});
