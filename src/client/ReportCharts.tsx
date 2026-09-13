import { useRef, useState } from "react";
import { durationLabel, type ReportDay } from "../shared/reports";

type Series =
  | "created"
  | "received"
  | "sent"
  | "resolved"
  | "first_response"
  | "response"
  | "resolution";
const labels: Record<Series, string> = {
  created: "New conversations",
  received: "Messages received",
  sent: "Emails sent",
  resolved: "Resolved",
  first_response: "First response time",
  response: "Response time",
  resolution: "Resolution time",
};
export function DailyChart({
  days,
  performance,
}: {
  days: ReportDay[];
  performance: boolean;
}) {
  const [volume, setVolume] = useState<Series>("received"),
    [speed, setSpeed] = useState<Series>("first_response");
  const series = performance ? speed : volume,
    duration = typeof days[0]?.[series] === "object";
  const values = days.map((d) => {
    const n = d[series];
    return typeof n === "number" ? n : n.average;
  });
  const max = Math.max(duration ? 60000 : 1, ...values.map((v) => v || 0));
  const [hover, setHover] = useState<number | null>(null);
  const chosen = hover === null ? -1 : Math.min(hover, days.length - 1);
  const format = (v: number | null) =>
    duration ? durationLabel(v) : (v ?? 0).toLocaleString();
  const width = 900,
    height = 225,
    left = 65,
    right = 12,
    top = 18,
    bottom = 36;
  const area = width - left - right,
    plotHeight = height - top - bottom,
    slot = area / Math.max(1, days.length);
  const x = (index: number) => left + slot * (index + 0.5),
    y = (value: number) => top + plotHeight * (1 - value / max);
  return (
    <section className="report-panel report-chart" aria-label="Daily activity">
      <div className="report-panel-heading">
        <h2>{performance ? "Response & resolution trends" : "Email volume"}</h2>
        <select
          aria-label="Chart metric"
          value={series}
          onChange={(e) => {
            (performance ? setSpeed : setVolume)(e.target.value as Series);
            setHover(null);
          }}
        >
          {(performance
            ? (["first_response", "response", "resolution"] as const)
            : (["received", "sent", "created", "resolved"] as const)
          ).map((key) => (
            <option key={key} value={key}>
              {labels[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="report-chart-detail" aria-live="polite">
        {chosen >= 0 ? (
          <>
            <strong>{days[chosen].date}</strong> · {format(values[chosen])}{" "}
            {duration ? "average" : labels[series].toLowerCase()}
          </>
        ) : (
          <>
            {labels[series]} by day{duration ? " · daily averages" : ""}
          </>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${labels[series]} by day. Exact values are available in the data table below.`}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1={left}
              x2={width - right}
              y1={y(max * fraction)}
              y2={y(max * fraction)}
              stroke="#e5ebe7"
            />
            <text x={left - 12} y={y(max * fraction) + 4} textAnchor="end">
              {format(duration ? max * fraction : Math.round(max * fraction))}
            </text>
          </g>
        ))}
        {days.map((day, index) => (
          <g key={day.date}>
            {values[index] !== null && (
              <rect
                x={x(index) - slot * 0.32}
                y={y(values[index]!)}
                width={Math.max(1, slot * 0.64)}
                height={Math.max(
                  values[index] ? 2 : 0,
                  (plotHeight * values[index]!) / max,
                )}
                rx={Math.min(3, slot / 4)}
                fill={chosen === index ? "#104b3b" : "#34836a"}
              />
            )}
            <rect
              x={left + slot * index}
              y={top}
              width={slot}
              height={plotHeight}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            >
              <title>
                {day.date}: {format(values[index])}
              </title>
            </rect>
            {(index === 0 ||
              index === days.length - 1 ||
              (days.length > 3 && index === Math.floor(days.length / 2))) && (
              <text
                x={x(index)}
                y={height - 10}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === days.length - 1
                      ? "end"
                      : "middle"
                }
              >
                {day.date.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      {!values.some((v) => v !== null && (duration || v > 0)) && (
        <p className="report-chart-empty">
          {duration
            ? "No timing samples in this period."
            : "No activity for this metric in this period."}
        </p>
      )}
      <details className="report-data-table">
        <summary>View daily data</summary>
        <div className="report-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>{labels[series]}</th>
                {duration && <th>Samples</th>}
              </tr>
            </thead>
            <tbody>
              {days.map((day, i) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{format(values[i])}</td>
                  {duration && (
                    <td>
                      {typeof day[series] === "object" ? day[series].count : ""}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function BusyHours({
  values,
  timezone,
}: {
  values: number[][];
  timezone: string;
}) {
  const names = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const max = Math.max(1, ...values.flat()),
    total = values.flat().reduce((sum, n) => sum + n, 0);
  const [active, setActive] = useState<number | null>(null);
  const [focusCell, setFocusCell] = useState(0);
  const heatmap = useRef<HTMLDivElement>(null);
  const cellLabel = (d: number, h: number) =>
    `${names[d]}, ${h.toString().padStart(2, "0")}:00–${(h + 1).toString().padStart(2, "0")}:00: ${values[d][h]} incoming message${values[d][h] === 1 ? "" : "s"}`;
  return (
    <section className="report-panel">
      <div className="report-panel-heading">
        <h2>Busiest hours</h2>
        <span>{timezone}</span>
      </div>
      <div className="report-heatmap-scroll">
        <div
          className="report-heatmap"
          ref={heatmap}
          aria-label="Incoming messages by weekday and hour"
        >
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span className="heatmap-hour" key={hour}>
              {hour % 3 === 0 ? `${hour.toString().padStart(2, "0")}` : ""}
            </span>
          ))}
          {values.map((day, d) => (
            <div className="heatmap-row" key={d}>
              <span className="heatmap-day">{names[d].slice(0, 3)}</span>
              {day.map((count, h) => {
                const label = cellLabel(d, h);
                return (
                  <button
                    key={h}
                    tabIndex={focusCell === d * 24 + h ? 0 : -1}
                    onKeyDown={(event) => {
                      const step = {
                        ArrowLeft: -1,
                        ArrowRight: 1,
                        ArrowUp: -24,
                        ArrowDown: 24,
                      }[event.key];
                      if (step === undefined) return;
                      event.preventDefault();
                      const next = Math.max(
                        0,
                        Math.min(167, d * 24 + h + step),
                      );
                      setFocusCell(next);
                      heatmap.current
                        ?.querySelectorAll("button")
                        [next]?.focus();
                    }}
                    aria-label={label}
                    title={label}
                    style={{
                      background: count
                        ? `rgba(23, 106, 84, ${0.18 + (0.82 * count) / max})`
                        : "#edf2ee",
                    }}
                    onFocus={() => {
                      setActive(d * 24 + h);
                      setFocusCell(d * 24 + h);
                    }}
                    onClick={() => setActive(d * 24 + h)}
                    onMouseEnter={() => setActive(d * 24 + h)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="report-heatmap-detail" aria-live="polite">
        {active !== null
          ? cellLabel(Math.floor(active / 24), active % 24)
          : total
            ? "Select a cell to see its count. Use arrow keys to move between cells."
            : "No incoming messages in this period."}
      </p>
    </section>
  );
}
