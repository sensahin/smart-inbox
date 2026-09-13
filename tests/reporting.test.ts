import { describe, expect, it } from "vitest";
import {
  aggregatePeriod,
  csvCell,
  reportPeriod,
  startOfDate,
  timing,
  type ReportMessage,
  type ReportTicket,
} from "../src/worker/reporting";
import { filterReportRows } from "../src/worker/routes/reports";
const at = (s: string) => Date.parse(s);
const base = at("2026-05-01T08:00:00Z");
const hour = 3600000;
const ticket: ReportTicket = {
  id: "t1",
  number: 1,
  subject: "Question",
  inbox_id: "i",
  inbox_name: "Support",
  contact_id: "c",
  contact_name: "Customer",
  contact_email: "customer@example.test",
  status: "open",
  history_missing: 0,
  created_at: base,
  closed_at: null,
};
const msg = (
  id: string,
  direction: string,
  time: number,
  kind: string | null = null,
): ReportMessage => ({
  id,
  conversation_id: "t1",
  direction,
  sent_at: time,
  kind,
  recipients: '["customer@example.test"]',
  cc: "[]",
});
function aggregate(
  messages: ReportMessage[],
  changes: Partial<ReportTicket> = {},
  from = "2026-05-01",
  to = from,
  timezone = "UTC",
) {
  const p = reportPeriod(from, to, timezone);
  return aggregatePeriod(
    [{ ...ticket, ...changes }],
    messages,
    [],
    from,
    to,
    p.start,
    p.end,
    timezone,
  );
}

describe("report timing and inclusion", () => {
  it("times the earliest unanswered message and ignores auto replies, forwards and consecutive outgoing messages", () => {
    const data = aggregate(
      [
        msg("i1", "inbound", base),
        msg("ack", "auto", base + 1000),
        msg("i2", "inbound", base + hour),
        msg("forward", "outbound", base + 2 * hour, "forward"),
        msg("r1", "outbound", base + 3 * hour, "reply"),
        msg("r2", "outbound", base + 4 * hour, "reply"),
        msg("i3", "inbound", base + 5 * hour),
        msg("r3", "outbound", base + 6 * hour, "reply"),
      ].reverse(),
    );
    expect(data.metrics.received).toBe(3);
    expect(data.metrics.sent).toBe(4);
    expect(data.metrics.first_response).toMatchObject({
      count: 1,
      average: 3 * hour,
    });
    expect(data.metrics.response).toMatchObject({
      count: 2,
      average: 2 * hour,
      median: 2 * hour,
      p90: 3 * hour,
    });
    expect(data.metrics.helped).toBe(1);
    expect(data.distribution.reduce((sum, n) => sum + n.count, 0)).toBe(2);
  });
  it("counts response samples in the reply period while preserving earlier context", () => {
    const data = aggregate([
      msg("i", "inbound", base - 24 * hour),
      msg("r", "outbound", base + hour),
    ]);
    expect(data.metrics.response.average).toBe(25 * hour);
    expect(data.metrics.received).toBe(0);
    expect(data.metrics.sent).toBe(1);
    expect(data.metrics.first_response.average).toBe(25 * hour);
  });
  it("does not treat a new outbound conversation or an email to someone else as a first response", () => {
    const messages = [
      msg("new", "outbound", base, "new"),
      msg("i", "inbound", base + hour),
      {
        ...msg("f", "outbound", base + 2 * hour),
        recipients: '["colleague@example.test"]',
      },
      msg("r", "outbound", base + 3 * hour),
    ];
    const data = aggregate(messages);
    expect(data.metrics.first_response.count).toBe(0);
    expect(data.metrics.response.average).toBe(2 * hour);
    expect(aggregate(messages.slice(0, 3)).metrics.helped).toBe(0);
  });
  it("keeps a zero-duration response as a real sample", () => {
    const data = aggregate([
      msg("r", "outbound", base),
      msg("i", "inbound", base),
    ]);
    expect(data.metrics.first_response).toMatchObject({ count: 1, average: 0 });
    expect(filterReportRows(data.rows, "first_response")).toHaveLength(1);
  });
  it("excludes incomplete history from first response and resolution durations", () => {
    const data = aggregate(
      [msg("i", "inbound", base), msg("r", "outbound", base + hour)],
      { status: "closed", closed_at: base + 2 * hour, history_missing: 1 },
    );
    expect(data.metrics.first_response.count).toBe(0);
    expect(data.metrics.response.average).toBe(hour);
    expect(data.metrics.resolved).toBe(1);
    expect(data.metrics.resolution.average).toBeNull();
    expect(data.metrics.one_reply_percent).toBeNull();
  });
  it("requires a recorded closure and reply, and removes reopened resolutions", () => {
    const messages = [
      msg("i", "inbound", base),
      msg("r", "outbound", base + hour),
    ];
    expect(aggregate(messages, { status: "closed" }).metrics.resolved).toBe(0);
    expect(
      aggregate(messages, { status: "open", closed_at: base + 2 * hour })
        .metrics.resolved,
    ).toBe(0);
    expect(
      aggregate(messages.slice(0, 1), {
        status: "closed",
        closed_at: base + 2 * hour,
      }).metrics.resolved,
    ).toBe(0);
    const closed = aggregate(messages, {
      status: "closed",
      closed_at: base + 2 * hour,
    });
    expect(closed.metrics.resolved).toBe(1);
    expect(closed.metrics.resolution.average).toBe(2 * hour);
    expect(closed.metrics.one_reply_percent).toBe(100);
    expect(
      aggregate([...messages, msg("r2", "outbound", base + 1.5 * hour)], {
        status: "closed",
        closed_at: base + 2 * hour,
      }).metrics.one_reply_percent,
    ).toBe(0);
  });
  it("returns empty timing samples as unknown and zero-filled daily volume", () => {
    const data = aggregate([], {}, "2026-06-01", "2026-06-07");
    expect(data.metrics.active).toBe(0);
    expect(data.metrics.first_response.average).toBeNull();
    expect(data.days).toHaveLength(7);
    expect(
      data.days.every(
        (d) => d.received === 0 && d.first_response.average === null,
      ),
    ).toBe(true);
  });
  it("counts unique customers across conversations and groups inbound volume by local weekday and hour", () => {
    const midnight = at("2026-05-02T00:00:00+03:00");
    const data = aggregate(
      [
        msg("before", "inbound", midnight - 1),
        msg("after", "inbound", midnight),
      ],
      {},
      "2026-05-02",
      "2026-05-02",
      "Europe/Istanbul",
    );
    expect(data.metrics.received).toBe(1);
    expect(data.metrics.customers).toBe(1);
    expect(data.heatmap[5][0]).toBe(1);
    expect(data.days[0].received).toBe(1);
  });
});

describe("report date boundaries and exports", () => {
  it("uses calendar days across daylight saving rather than fixed 24-hour windows", () => {
    const spring = reportPeriod("2026-03-08", "2026-03-08", "America/New_York");
    expect(spring.start).toBe(at("2026-03-08T05:00:00Z"));
    expect(spring.end - spring.start).toBe(23 * hour);
    expect(spring.previous_to).toBe("2026-03-07");
    const autumn = reportPeriod("2026-11-01", "2026-11-01", "America/New_York");
    expect(autumn.end - autumn.start).toBe(25 * hour);
    expect(startOfDate("2026-05-02", "Asia/Kolkata")).toBe(
      at("2026-05-01T18:30:00Z"),
    );
    expect(startOfDate("2018-11-04", "America/Sao_Paulo")).toBe(
      at("2018-11-04T03:00:00Z"),
    );
  });
  it("calculates percentiles and rejects formulas in quoted CSV fields", () => {
    expect(timing([100, 200, 300, 400])).toEqual({
      average: 250,
      median: 250,
      p90: 400,
      count: 4,
    });
    expect(csvCell('A, "quoted"\nsubject')).toBe('"A, ""quoted""\nsubject"');
    expect(csvCell("  =HYPERLINK(1)")).toBe('"\'  =HYPERLINK(1)"');
    expect(csvCell("\t+10")).toBe('"\'\t+10"');
    expect(csvCell(null)).toBe('""');
  });
});
