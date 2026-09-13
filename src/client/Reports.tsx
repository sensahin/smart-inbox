import { useEffect, useRef, useState } from "react";
import {
  Download,
  Info,
  RefreshCw,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { Inbox } from "../shared/types";
import {
  durationLabel,
  reportDate,
  shiftDate,
  reportDefinitions,
  type Report,
  type ReportConversation,
  type ReportFilter,
  type ReportMetrics,
  type Timing,
} from "../shared/reports";
import { useResource } from "./api";
import type { Notify } from "./Toast";
import { BusyHours, DailyChart } from "./ReportCharts";
import "./Reports.css";

const metricNames: Record<ReportFilter, string> = {
  active: "Active conversations",
  created: "New conversations",
  received: "Messages received",
  sent: "Emails sent",
  resolved: "Resolved conversations",
  first_response: "First responses",
  response: "Customer responses",
};
type Props = {
  inboxes: Inbox[];
  inboxId: string;
  setInboxId: (id: string) => void;
  timezone: string;
  openConversation: (id: string) => void;
  openContact: (id: string) => void;
  notify: Notify;
};
type ConversationPage = {
  items: ReportConversation[];
  total: number;
  has_more: boolean;
};

function Definition({ name, text }: { name: string; text: string }) {
  return (
    <details className="report-definition">
      <summary aria-label={`About ${name}`} title={`About ${name}`}>
        <Info size={14} />
      </summary>
      <p>{text}</p>
    </details>
  );
}
function Change({
  value,
  previous,
  lowerBetter,
}: {
  value: number | null;
  previous: number | null;
  lowerBetter?: boolean;
}) {
  if (value === null || previous === null || previous === 0)
    return (
      <small className="report-change">
        {value === 0 && previous === 0 ? "No change" : "No prior baseline"}
      </small>
    );
  const percent = ((value - previous) / previous) * 100;
  return (
    <small
      className={`report-change ${lowerBetter && percent ? (percent < 0 ? "improved" : "slower") : ""}`}
    >
      {percent > 0 ? "+" : ""}
      {Math.round(percent)}% <span>vs previous period</span>
    </small>
  );
}
function Metric({
  name,
  value,
  previous,
  help,
  compare,
  duration,
  samples,
  onClick,
  coverage,
}: {
  name: string;
  value: number | null;
  previous: number | null;
  help: string;
  compare: boolean;
  duration?: boolean;
  samples?: number;
  onClick?: () => void;
  coverage?: boolean;
}) {
  const display = duration
    ? durationLabel(value)
    : value === null
      ? "—"
      : value.toLocaleString();
  return (
    <div className="report-metric">
      <div className="report-metric-label">
        <span>{name}</span>
        <Definition name={name} text={help} />
      </div>
      {onClick ? (
        <button
          className="report-metric-value"
          onClick={onClick}
          aria-label={`Inspect ${name.toLowerCase()}`}
        >
          {display}
          <ArrowUpRight size={15} />
        </button>
      ) : (
        <strong className="report-metric-value">{display}</strong>
      )}
      {samples !== undefined && (
        <span className="report-samples">
          {samples.toLocaleString()} sample{samples === 1 ? "" : "s"}
        </span>
      )}
      {compare &&
        (coverage ? (
          <small className="report-change">Limited closure history</small>
        ) : (
          <Change value={value} previous={previous} lowerBetter={duration} />
        ))}
    </div>
  );
}

export function Reports({
  inboxes,
  inboxId,
  setInboxId,
  timezone,
  openConversation,
  openContact,
  notify,
}: Props) {
  const today = reportDate(Date.now(), timezone);
  const [range, setRange] = useState({ from: shiftDate(today, -6), to: today });
  const [preset, setPreset] = useState("7"),
    [compare, setCompare] = useState(true);
  const [tab, setTab] = useState<"overview" | "performance">("overview"),
    [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<ReportFilter>("active"),
    [offset, setOffset] = useState(0),
    [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState("daily");
  const detailRef = useRef<HTMLElement>(null),
    exportAbort = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbort.current?.abort(), []);
  const params = new URLSearchParams({ ...range, inbox: inboxId }).toString();
  const result = useResource<Report>(`/reports?${params}`, refresh);
  const detail = useResource<ConversationPage>(
    `/reports/conversations?${params}&filter=${filter}&offset=${offset}`,
    refresh,
  );
  useEffect(() => {
    setOffset(0);
  }, [range, inboxId, filter]);
  const report = result.data;
  function selectPreset(value: string) {
    setPreset(value);
    if (value === "custom") return;
    const monthStart = today.slice(0, 7) + "-01";
    const lastMonthEnd = shiftDate(monthStart, -1);
    const next =
      value === "today"
        ? { from: today, to: today }
        : value === "yesterday"
          ? { from: shiftDate(today, -1), to: shiftDate(today, -1) }
          : value === "month"
            ? { from: monthStart, to: today }
            : value === "last_month"
              ? { from: lastMonthEnd.slice(0, 7) + "-01", to: lastMonthEnd }
              : { from: shiftDate(today, -(Number(value) - 1)), to: today };
    setRange(next);
  }
  function inspect(next: ReportFilter) {
    setFilter(next);
    setOffset(0);
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    detailRef.current?.focus({ preventScroll: true });
  }
  async function download() {
    if (exporting) return;
    setExporting(true);
    const controller = new AbortController();
    exportAbort.current = controller;
    try {
      const response = await fetch(
        `/api/reports/export?${params}&filter=${filter}&format=${exportFormat}`,
        { headers: { "X-Support-Request": "1" }, signal: controller.signal },
      );
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/csv")
      ) {
        const body = response.headers
          .get("content-type")
          ?.includes("application/json")
          ? ((await response.json()) as { error?: string })
          : null;
        throw new Error(
          body?.error ||
            "Export failed. Reload to check your sign-in, then try again.",
        );
      }
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement("a");
      link.href = url;
      link.download = `smart-inbox-${exportFormat}-${range.from}-${range.to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser a turn to begin reading before releasing the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Report exported.", "success");
    } catch (e) {
      if (!controller.signal.aborted) notify((e as Error).message, "error");
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  }
  const countCard = (
    key: "active" | "created" | "received" | "sent" | "resolved",
    name = metricNames[key],
  ) =>
    report && (
      <Metric
        key={key}
        name={name}
        value={report.metrics[key]}
        previous={report.previous[key]}
        help={reportDefinitions[key]}
        compare={compare}
        onClick={() => inspect(key)}
        coverage={key === "resolved" && report.coverage_incomplete}
      />
    );
  const timeCard = (
    key: "first_response" | "response" | "resolution",
    name: string,
  ) =>
    report && (
      <Metric
        key={key}
        name={name}
        value={report.metrics[key].average}
        previous={report.previous[key].average}
        samples={report.metrics[key].count}
        help={reportDefinitions[key]}
        compare={compare}
        duration
        onClick={() => inspect(key === "resolution" ? "resolved" : key)}
        coverage={key === "resolution" && report.coverage_incomplete}
      />
    );
  return (
    <section className="reports-page" aria-labelledby="reports-title">
      <header className="list-toolbar">
        <h1 id="reports-title">Reports</h1>
        <button
          className="button"
          onClick={() => setRefresh((v) => v + 1)}
          disabled={result.loading || detail.loading}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </header>
      <div className="reports-content">
        <form
          className="report-filters"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setRange({
              from: String(form.get("from")),
              to: String(form.get("to")),
            });
          }}
        >
          <label>
            Period
            <select
              value={preset}
              onChange={(e) => selectPreset(e.target.value)}
            >
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="month">This month</option>
              <option value="last_month">Last month</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          {preset === "custom" && (
            <>
              <label>
                From
                <input
                  type="date"
                  name="from"
                  key={range.from}
                  defaultValue={range.from}
                  min="2000-01-01"
                  max={today}
                  required
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  name="to"
                  key={range.to}
                  defaultValue={range.to}
                  min="2000-01-01"
                  max={today}
                  required
                />
              </label>
              <button className="button" type="submit">
                Apply
              </button>
            </>
          )}
          <label>
            Inbox
            <select
              value={inboxId}
              onChange={(e) => setInboxId(e.target.value)}
            >
              <option value="">All inboxes</option>
              {inboxes.map((inbox) => (
                <option key={inbox.id} value={inbox.id}>
                  {inbox.name}
                </option>
              ))}
            </select>
          </label>
          <label className="report-comparison">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
            />{" "}
            Compare previous period
          </label>
        </form>
        <div className="report-period">
          <span>
            {range.from} – {range.to} · {timezone}
          </span>
          {report && (
            <span>
              Updated{" "}
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: timezone,
                hour: "2-digit",
                minute: "2-digit",
              }).format(report.generated_at)}
              {result.loading ? " · Refreshing…" : ""}
            </span>
          )}
        </div>
        {compare && report && (
          <p className="report-context">
            Compared with {report.previous_from} – {report.previous_to}
            {report.partial_day
              ? ". Today is still in progress; the previous period contains complete days."
              : "."}
          </p>
        )}
        <div className="report-tabs" role="group" aria-label="Report type">
          <button
            aria-pressed={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            aria-pressed={tab === "performance"}
            onClick={() => setTab("performance")}
          >
            Email performance
          </button>
        </div>
        {result.error && (
          <div className="report-error" role="alert">
            {result.error}
          </div>
        )}
        {!report && !result.error && (
          <div className="report-loading" role="status">
            Loading report…
          </div>
        )}
        {report && (
          <>
            <div className="report-metrics">
              {tab === "overview" ? (
                <>
                  {countCard("active")}
                  {countCard("created")}
                  {countCard("received")}
                  {countCard("sent")}
                </>
              ) : (
                <>
                  {timeCard("first_response", "First response time")}
                  {timeCard("response", "Response time")}
                  {countCard("resolved")}
                  {timeCard("resolution", "Resolution time")}
                </>
              )}
            </div>
            <div className="report-highlights">
              {tab === "overview" ? (
                <>
                  <span>
                    <strong>{report.metrics.customers}</strong> customers{" "}
                    <Definition
                      name="customers"
                      text={reportDefinitions.customers}
                    />
                  </span>
                  <span>
                    <strong>{report.metrics.helped}</strong> customers helped{" "}
                    <Definition
                      name="customers helped"
                      text={reportDefinitions.helped}
                    />
                  </span>
                  <span>
                    <strong>{report.backlog.open}</strong> Open now
                  </span>
                  <span>
                    <strong>{report.backlog.waiting}</strong> Waiting now
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <strong>
                      {report.metrics.one_reply_percent === null
                        ? "—"
                        : `${report.metrics.one_reply_percent}%`}
                    </strong>{" "}
                    resolved with one reply{" "}
                    <Definition
                      name="resolved with one reply"
                      text={reportDefinitions.one_reply_percent}
                    />
                  </span>
                  <span>Times include nights and weekends.</span>
                </>
              )}
            </div>
            {report.coverage_incomplete && (
              <p className="report-coverage">
                <Info size={16} />
                <span>
                  Closure history{" "}
                  {report.reporting_started_at
                    ? `starts ${reportDate(report.reporting_started_at, timezone)}`
                    : "is not available yet"}
                  . Earlier resolutions cannot be calculated. Reopened
                  conversations are counted again only after they are closed.
                </span>
              </p>
            )}
            <DailyChart
              days={report.days}
              performance={tab === "performance"}
            />
            {tab === "overview" ? (
              <>
                <BusyHours values={report.heatmap} timezone={timezone} />
                <div className="report-two-columns">
                  <section className="report-panel">
                    <div className="report-panel-heading">
                      <h2>Most active customers</h2>
                      <span>Top 10 · incoming activity</span>
                    </div>
                    <div className="report-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Customer</th>
                            <th>Conversations</th>
                            <th>Received</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.customers.map((customer) => (
                            <tr key={customer.id}>
                              <td>
                                <button
                                  className="report-text-link"
                                  onClick={() => openContact(customer.id)}
                                >
                                  {customer.name || customer.email}
                                </button>
                                <small className="report-email">
                                  {customer.email}
                                </small>
                              </td>
                              <td>{customer.conversations}</td>
                              <td>{customer.received}</td>
                            </tr>
                          ))}
                          {!report.customers.length && (
                            <tr>
                              <td colSpan={3} className="report-empty">
                                No incoming customer activity in this period.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="report-panel">
                    <div className="report-panel-heading">
                      <h2>Activity by inbox</h2>
                    </div>
                    <div className="report-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Inbox</th>
                            <th>New</th>
                            <th>Received</th>
                            <th>Sent</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.inboxes.map((inbox) => (
                            <tr key={inbox.id}>
                              <td>
                                <button
                                  className="report-text-link"
                                  onClick={() => setInboxId(inbox.id)}
                                >
                                  {inbox.name}
                                </button>
                              </td>
                              <td>{inbox.created}</td>
                              <td>{inbox.received}</td>
                              <td>{inbox.sent}</td>
                            </tr>
                          ))}
                          {!report.inboxes.length && (
                            <tr>
                              <td colSpan={4} className="report-empty">
                                No inbox activity in this period.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="report-two-columns">
                <section className="report-panel">
                  <div className="report-panel-heading">
                    <h2>Response time distribution</h2>
                    <span>{report.metrics.response.count} responses</span>
                  </div>
                  <div className="report-distribution">
                    {report.distribution.map((bucket) => {
                      const percent = report.metrics.response.count
                        ? (bucket.count / report.metrics.response.count) * 100
                        : 0;
                      return (
                        <div key={bucket.label}>
                          <span>{bucket.label}</span>
                          <div className="report-bar-track">
                            <i style={{ width: `${percent}%` }} />
                          </div>
                          <strong>{Math.round(percent)}%</strong>
                          <small>{bucket.count}</small>
                        </div>
                      );
                    })}
                  </div>
                </section>
                <TimingSummary metrics={report.metrics} />
              </div>
            )}
            <section
              className="report-panel report-conversations"
              ref={detailRef}
              tabIndex={-1}
              aria-label="Conversations behind this report"
            >
              <div className="report-panel-heading">
                <h2>
                  Conversations{" "}
                  <span className="report-total">
                    {detail.data?.total ?? "—"}
                  </span>
                </h2>
                <select
                  aria-label="Conversation metric"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as ReportFilter)}
                >
                  {Object.entries(metricNames).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {detail.error && (
                <p className="report-error" role="alert">
                  {detail.error}
                </p>
              )}
              <div className="report-table-scroll" aria-busy={detail.loading}>
                <table>
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Customer</th>
                      <th>Received</th>
                      <th>Sent</th>
                      <th>First response</th>
                      <th>Avg. response</th>
                      <th>Resolution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data?.items.map((row) => (
                      <tr key={row.id}>
                        <td className="report-subject">
                          <button
                            className="report-text-link"
                            onClick={() => openConversation(row.id)}
                            title={row.subject}
                          >
                            {row.subject || "(No subject)"}
                          </button>
                          <small>
                            #{row.number} · {row.inbox_name} · {row.status}
                          </small>
                        </td>
                        <td>{row.contact_name || row.contact_email}</td>
                        <td>{row.received}</td>
                        <td>{row.sent}</td>
                        <td>{durationLabel(row.first_response_ms)}</td>
                        <td>{durationLabel(row.response_ms)}</td>
                        <td>{durationLabel(row.resolution_ms)}</td>
                      </tr>
                    ))}
                    {!detail.data?.items.length && !detail.error && (
                      <tr>
                        <td colSpan={7} className="report-empty">
                          {detail.loading
                            ? "Loading conversations…"
                            : "No conversations match this metric in this period."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {detail.data && (offset > 0 || detail.data.has_more) && (
                <div className="report-pagination">
                  <span>
                    {offset + 1}–{offset + detail.data.items.length} of{" "}
                    {detail.data.total}
                  </span>
                  <button
                    className="button"
                    disabled={!offset || detail.loading}
                    onClick={() => setOffset((v) => Math.max(0, v - 50))}
                  >
                    <ChevronLeft size={15} /> Previous
                  </button>
                  <button
                    className="button"
                    disabled={!detail.data.has_more || detail.loading}
                    onClick={() => setOffset((v) => v + 50)}
                  >
                    Next <ChevronRight size={15} />
                  </button>
                </div>
              )}
            </section>
            <div className="report-footer">
              <span>
                Trash, automatic acknowledgements, and drafts are excluded.
              </span>
              <div>
                <select
                  aria-label="Export format"
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value)}
                >
                  <option value="daily">Daily metrics</option>
                  <option value="conversations">
                    Selected conversation metric
                  </option>
                </select>
                <button
                  className="button"
                  onClick={() => void download()}
                  disabled={exporting || result.loading || !!result.error}
                >
                  <Download size={15} />
                  {exporting ? "Exporting…" : "Export CSV"}
                </button>
              </div>
            </div>
            <details className="report-methodology">
              <summary>How these reports are calculated</summary>
              <p>
                Dates use your workspace time zone. Response times use elapsed
                time, including nights and weekends. The chart fills days
                without activity with zero; a dash means there is no timing
                sample. Sent counts include accepted new emails and forwards;
                only replies to the conversation’s customer stop response
                timers.
              </p>
              <p>
                Open now and Waiting now show the current workload across the
                selected inboxes, independently of the report dates. Resolutions
                reflect the latest recorded closure of currently closed
                conversations, so reopening a ticket can change an earlier
                report. First response and resolution timings require complete
                recorded history. Later response timers use the recorded
                unanswered messages. Changing an inbox’s status does not measure
                time spent writing a reply.
              </p>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

function TimingSummary({ metrics }: { metrics: ReportMetrics }) {
  const entries: [string, Timing][] = [
    ["First response", metrics.first_response],
    ["Response", metrics.response],
    ["Resolution", metrics.resolution],
  ];
  return (
    <section className="report-panel">
      <div className="report-panel-heading">
        <h2>Timing summary</h2>
        <Definition
          name="timing statistics"
          text="Average is the arithmetic mean. Median is the middle sample. 90th percentile is the duration at or below which 90% of samples fall. All times include nights and weekends."
        />
      </div>
      <div className="report-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Median</th>
              <th>90th percentile</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([label, time]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{durationLabel(time.median)}</td>
                <td>{durationLabel(time.p90)}</td>
                <td>{time.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
