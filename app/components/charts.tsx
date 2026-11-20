// Interactive SVG charts. Colours come from the active theme (CSS variables).
// Hovering any chart shows a crosshair, the value on the axis and a tooltip, in
// the style of a stock chart. Works with mouse and touch.

import { useId, useRef, useState, type ReactNode } from "react";

const ACCENT = { fill: "var(--ss-accent)" };
const ACCENT_STROKE = { stroke: "var(--ss-accent)" };
const SOFT = { fill: "var(--ss-accent-soft)" };
const BAR = { fill: "var(--ss-bar)" };
const INK = { fill: "var(--ss-muted)" };
const GRID = { stroke: "var(--ss-grid)" };
const MUTED_STROKE = { stroke: "var(--ss-muted)" };
const SERIES_COLORS = ["var(--ss-accent)", "var(--ss-info)", "var(--ss-success)", "var(--ss-warning)"];

const DAY_MS = 86_400_000;
function dayLabel(today: string | undefined, offset: number) {
  if (!today) return offset === 0 ? "Today" : `${offset > 0 ? "+" : ""}${offset}d`;
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d) + offset * DAY_MS);
  const txt = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return offset === 0 ? `Today · ${txt}` : txt;
}
const fmtNum = (n: number, digits = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);

/* ---------- Hover plumbing ---------- */

interface HoverState {
  i: number;
  px: number; // tooltip x as a fraction of the width (0..1)
}

/** Maps pointer position to a data index. `indexAt` receives the x position in viewBox units. */
function useHover(width: number, indexAt: (vx: number) => number | null) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const move = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const i = indexAt(frac * width);
    setHover(i === null ? null : { i, px: frac });
  };
  const handlers = {
    onPointerMove: (e: React.PointerEvent) => move(e.clientX),
    onPointerDown: (e: React.PointerEvent) => move(e.clientX),
    onPointerLeave: () => setHover(null),
  };
  return { ref, hover, handlers };
}

function Tooltip({ x, children }: { x: number; children: ReactNode }) {
  // Keep the tooltip inside the chart: anchor left, centre or right depending on position.
  const shift = x < 0.18 ? "0%" : x > 0.82 ? "-100%" : "-50%";
  return (
    <div className="ss-tip" style={{ left: `${x * 100}%`, transform: `translateX(${shift})` }} role="status">
      {children}
    </div>
  );
}

export function TipRow({ color, label, value }: { color?: string; label: string; value: ReactNode }) {
  return (
    <div className="ss-tip-row">
      <span>
        {color && <i style={{ background: color }} />}
        {label}
      </span>
      <b>{value}</b>
    </div>
  );
}

/* ---------- Weekly bars (dashboard) ---------- */

export interface WeekPoint {
  label: string;
  value: number;
  forecast: boolean;
  from?: string;
  to?: string;
}

export function WeeklyBars({ data, height = 200 }: { data: WeekPoint[]; height?: number }) {
  const w = 720;
  const h = height;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const max = Math.max(1, ...data.map((d) => d.value)) * 1.1;
  const bw = (w - pad.l - pad.r) / data.length;
  const y = (v: number) => h - pad.b - ((h - pad.t - pad.b) * v) / max;
  const { ref, hover, handlers } = useHover(w, (vx) => {
    const i = Math.floor((vx - pad.l) / bw);
    return i >= 0 && i < data.length ? i : null;
  });
  const hd = hover ? data[hover.i] : null;

  return (
    <div className="ss-chart-wrap">
      <svg ref={ref} className="ss-chart" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Units sold per week against forecast" {...handlers}>
        {hd && <line x1={pad.l} x2={w - pad.r} y1={y(hd.value)} y2={y(hd.value)} style={MUTED_STROKE} strokeDasharray="3 4" opacity={0.6} />}
        {data.map((d, i) => {
          const bh = h - pad.b - y(d.value);
          const x = pad.l + i * bw + bw * 0.14;
          const active = hover?.i === i;
          return (
            <g key={d.label}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={h - pad.t - pad.b} style={{ fill: active ? "var(--ss-neutral-bg)" : "transparent" }} />
              <rect x={x} y={h - pad.b - bh} width={bw * 0.72} height={Math.max(2, bh)} rx={4} style={d.forecast ? ACCENT : BAR} opacity={hover && !active ? 0.55 : 1} />
              {(i % 4 === 0 || i === data.length - 1) && (
                <text x={x + bw * 0.36} y={h - 6} textAnchor="middle" style={INK}>
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hd && hover && (
        <Tooltip x={(pad.l + (hover.i + 0.5) * bw) / w}>
          <div className="ss-tip-title">{hd.from ? `${hd.label} · ${hd.from} to ${hd.to}` : hd.label}</div>
          <TipRow color={hd.forecast ? "var(--ss-accent)" : "var(--ss-bar)"} label={hd.forecast ? "Forecast" : "Units sold"} value={fmtNum(hd.value)} />
        </Tooltip>
      )}
    </div>
  );
}

/* ---------- Stock curve (spotlight, SKU page, chat) ---------- */

/**
 * Units on hand over time: recent history (rebuilt from sales) flowing into the
 * projection, with the reorder point as a dashed line and a dot where stock
 * crosses it. Optional 80% band on the projected part.
 */
export function StockCurve({
  past,
  now,
  future,
  futureLow,
  futureHigh,
  reorderPoint,
  crossingDay,
  leadTimeDay,
  today,
  height = 200,
  width = 560,
  showAxis = false,
}: {
  past: number[];
  now: number;
  future: number[];
  futureLow?: number[];
  futureHigh?: number[];
  reorderPoint: number;
  crossingDay: number | null;
  leadTimeDay?: number;
  today?: string;
  height?: number;
  width?: number;
  showAxis?: boolean;
}) {
  const gid = useId().replace(/:/g, "");
  const w = width;
  const h = height;
  const pad = { l: showAxis ? 34 : 10, r: 10, t: 16, b: showAxis ? 22 : 10 };
  const values = [...past, now, ...future];
  const n = values.length;
  const todayIdx = past.length;
  const max = Math.max(1, reorderPoint * 1.25, ...values, ...(futureHigh ?? [])) * 1.08;
  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => h - pad.b - (Math.max(0, v) / max) * (h - pad.t - pad.b);
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const line = smoothPath(pts, y(0), y(max));
  const area = `${line} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  let band: string | null = null;
  if (futureLow && futureHigh && futureLow.length) {
    const hi = [[x(todayIdx), y(now)] as [number, number], ...futureHigh.map((v, i) => [x(todayIdx + 1 + i), y(v)] as [number, number])];
    const lo = [[x(todayIdx), y(now)] as [number, number], ...futureLow.map((v, i) => [x(todayIdx + 1 + i), y(v)] as [number, number])];
    band = `M${hi.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L")} L${lo
      .reverse()
      .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
      .join(" L")} Z`;
  }

  let dot: [number, number] | null = null;
  if (crossingDay !== null) {
    const i = todayIdx + crossingDay;
    if (i > 0 && i < n) {
      const a = values[i - 1];
      const b = values[i];
      const t = a === b ? 0 : (a - reorderPoint) / (a - b);
      dot = [x(i - 1 + t), y(reorderPoint)];
    }
  }
  const ltIdx = leadTimeDay !== undefined ? todayIdx + leadTimeDay : null;

  const { ref, hover, handlers } = useHover(w, (vx) => {
    const i = Math.round(((vx - pad.l) / (w - pad.l - pad.r)) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  });
  const hi = hover?.i ?? null;
  const offset = hi !== null ? hi - todayIdx : 0;
  const hv = hi !== null ? values[hi] : 0;

  return (
    <div className="ss-chart-wrap">
      <svg ref={ref} className="ss-chart" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Projected units on hand" {...handlers}>
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--ss-accent)", stopOpacity: 0.32 }} />
            <stop offset="100%" style={{ stopColor: "var(--ss-accent)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {[0.33, 0.66].map((f) => (
          <line key={f} x1={pad.l} x2={w - pad.r} y1={pad.t + (h - pad.t - pad.b) * f} y2={pad.t + (h - pad.t - pad.b) * f} style={GRID} />
        ))}
        {showAxis &&
          [0, Math.round(max / 2), Math.round(max)].map((t) => (
            <text key={t} x={pad.l - 6} y={y(t) + 4} textAnchor="end" style={INK}>
              {t}
            </text>
          ))}
        {band && <path d={band} style={SOFT} opacity={0.7} />}
        <path d={area} fill={`url(#g${gid})`} />
        <line x1={x(todayIdx)} x2={x(todayIdx)} y1={pad.t} y2={h - pad.b} style={MUTED_STROKE} strokeDasharray="2 4" opacity={0.45} />
        <text x={x(todayIdx) + 4} y={pad.t + 9} style={INK}>
          today
        </text>
        {ltIdx !== null && ltIdx < n && (
          <g>
            <line x1={x(ltIdx)} x2={x(ltIdx)} y1={pad.t} y2={h - pad.b} style={MUTED_STROKE} strokeDasharray="2 4" opacity={0.3} />
            <text x={x(ltIdx) + 4} y={pad.t + 9} style={INK}>
              order today lands
            </text>
          </g>
        )}
        <line x1={pad.l} x2={w - pad.r} y1={y(reorderPoint)} y2={y(reorderPoint)} style={{ stroke: "var(--ss-text-2)" }} strokeDasharray="5 4" opacity={0.7} />
        <text x={w - pad.r - 4} y={y(reorderPoint) - 6} textAnchor="end" style={INK}>
          reorder point
        </text>
        <path d={line} fill="none" style={ACCENT_STROKE} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
        {dot && (
          <g>
            <circle cx={dot[0]} cy={dot[1]} r={8} style={SOFT} />
            <circle cx={dot[0]} cy={dot[1]} r={4} style={ACCENT} />
          </g>
        )}
        {hi !== null && (
          <g pointerEvents="none">
            <line x1={x(hi)} x2={x(hi)} y1={pad.t} y2={h - pad.b} style={{ stroke: "var(--ss-text-2)" }} opacity={0.5} />
            <line x1={pad.l} x2={w - pad.r} y1={y(hv)} y2={y(hv)} style={{ stroke: "var(--ss-text-2)" }} strokeDasharray="3 4" opacity={0.35} />
            <circle cx={x(hi)} cy={y(hv)} r={5.5} style={{ fill: "var(--ss-surface)", stroke: "var(--ss-accent)" }} strokeWidth={2.5} />
            <rect x={w - pad.r - 44} y={y(hv) - 9} width={44} height={18} rx={4} style={ACCENT} />
            <text x={w - pad.r - 22} y={y(hv) + 4} textAnchor="middle" style={{ fill: "var(--ss-on-accent)" }}>
              {fmtNum(hv)}
            </text>
          </g>
        )}
        {showAxis && (
          <>
            <text x={x(0)} y={h - 6} style={INK}>
              -{past.length}d
            </text>
            <text x={x(n - 1)} y={h - 6} textAnchor="end" style={INK}>
              +{future.length}d
            </text>
          </>
        )}
      </svg>
      {hi !== null && hover && (
        <Tooltip x={x(hi) / w}>
          <div className="ss-tip-title">{dayLabel(today, offset)}</div>
          <TipRow color="var(--ss-accent)" label={offset < 0 ? "On hand (actual)" : offset === 0 ? "On hand now" : "On hand (projected)"} value={fmtNum(hv)} />
          {offset > 0 && futureLow && futureHigh && futureLow[offset - 1] !== undefined && (
            <TipRow label="80% range" value={`${fmtNum(futureLow[offset - 1])} to ${fmtNum(futureHigh[offset - 1])}`} />
          )}
          <TipRow label="Reorder point" value={fmtNum(reorderPoint)} />
          <div className={`ss-tip-note ${hv <= 0 ? "critical" : hv < reorderPoint ? "warning" : "success"}`}>
            {hv <= 0 ? "Out of stock" : hv < reorderPoint ? "Below reorder point" : "Above reorder point"}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** Catmull-Rom spline through the points as cubic Beziers, kept inside the plot. */
function smoothPath(pts: [number, number][], yMin: number, yMax: number): string {
  if (pts.length < 2) return "";
  const clampY = (v: number) => Math.min(yMin, Math.max(yMax, v));
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/* ---------- Weekly demand (SKU page) ---------- */

/** Weekly actual sales followed by weekly forecast with its 80% range. */
export function DemandChart({
  actual,
  forecast,
  low,
  high,
}: {
  actual: number[];
  forecast: number[];
  low: number[];
  high: number[];
}) {
  const w = 1200;
  const h = 260;
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const n = actual.length + forecast.length;
  const max = Math.max(1, ...actual, ...high) * 1.05;
  const bw = (w - pad.l - pad.r) / n;
  const y = (v: number) => h - pad.b - (Math.max(0, v) / max) * (h - pad.t - pad.b);
  const { ref, hover, handlers } = useHover(w, (vx) => {
    const i = Math.floor((vx - pad.l) / bw);
    return i >= 0 && i < n ? i : null;
  });
  const hi = hover?.i ?? null;
  const isForecast = hi !== null && hi >= actual.length;
  const fi = hi !== null ? hi - actual.length : 0;
  const hv = hi === null ? 0 : isForecast ? forecast[fi] : actual[hi];

  return (
    <div className="ss-chart-wrap">
      <svg ref={ref} className="ss-chart" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Weekly demand, actual and forecast" {...handlers}>
        {[0, Math.round(max / 2), Math.round(max)].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} style={GRID} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" style={INK}>
              {t}
            </text>
          </g>
        ))}
        {hi !== null && <rect x={pad.l + hi * bw} y={pad.t} width={bw} height={h - pad.t - pad.b} style={{ fill: "var(--ss-neutral-bg)" }} />}
        {hi !== null && <line x1={pad.l} x2={w - pad.r} y1={y(hv)} y2={y(hv)} style={MUTED_STROKE} strokeDasharray="3 4" opacity={0.6} />}
        {actual.map((v, i) => (
          <rect key={`a${i}`} x={pad.l + i * bw + bw * 0.15} y={y(v)} width={bw * 0.7} height={Math.max(2, y(0) - y(v))} rx={4} style={BAR} />
        ))}
        {forecast.map((v, i) => {
          const x = pad.l + (actual.length + i) * bw;
          return (
            <g key={`f${i}`}>
              <line x1={x + bw / 2} x2={x + bw / 2} y1={y(high[i])} y2={y(low[i])} style={ACCENT_STROKE} strokeWidth={1.5} opacity={0.6} />
              <line x1={x + bw * 0.3} x2={x + bw * 0.7} y1={y(high[i])} y2={y(high[i])} style={ACCENT_STROKE} strokeWidth={1.5} opacity={0.6} />
              <rect x={x + bw * 0.15} y={y(v)} width={bw * 0.7} height={Math.max(2, y(0) - y(v))} rx={4} style={ACCENT} opacity={0.85} />
            </g>
          );
        })}
        <text x={pad.l} y={h - 6} style={INK}>
          {actual.length} weeks ago
        </text>
        <text x={pad.l + actual.length * bw} y={h - 6} style={INK}>
          Today
        </text>
        <text x={w - pad.r} y={h - 6} textAnchor="end" style={INK}>
          +{forecast.length} weeks
        </text>
      </svg>
      {hi !== null && hover && (
        <Tooltip x={(pad.l + (hi + 0.5) * bw) / w}>
          <div className="ss-tip-title">{isForecast ? `Week +${fi + 1} (forecast)` : hi === actual.length - 1 ? "This week (so far)" : `${actual.length - hi} weeks ago`}</div>
          <TipRow color={isForecast ? "var(--ss-accent)" : "var(--ss-bar)"} label={isForecast ? "Forecast" : "Units sold"} value={fmtNum(hv)} />
          {isForecast && <TipRow label="80% range" value={`${fmtNum(low[fi])} to ${fmtNum(high[fi])}`} />}
        </Tooltip>
      )}
    </div>
  );
}

/* ---------- Generic chart (Ask StockSense replies) ---------- */

export interface ChartSpec {
  type: "bar" | "line";
  title?: string;
  unit?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}

export function SeriesChart({ spec, height = 220 }: { spec: ChartSpec; height?: number }) {
  const w = 560;
  const h = height;
  const pad = { l: 40, r: 10, t: 12, b: 34 };
  const n = spec.labels.length;
  const all = spec.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all) * 1.1;
  const min = Math.min(0, ...all);
  const y = (v: number) => h - pad.b - ((v - min) / (max - min)) * (h - pad.t - pad.b);
  const slot = (w - pad.l - pad.r) / Math.max(1, n);
  const cx = (i: number) => (spec.type === "bar" ? pad.l + (i + 0.5) * slot : pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r));
  const { ref, hover, handlers } = useHover(w, (vx) => {
    if (spec.type === "bar") {
      const i = Math.floor((vx - pad.l) / slot);
      return i >= 0 && i < n ? i : null;
    }
    const i = Math.round(((vx - pad.l) / (w - pad.l - pad.r)) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  });
  const hi = hover?.i ?? null;
  const groups = spec.series.length;
  const barW = (slot * 0.72) / groups;
  const step = Math.max(1, Math.ceil(n / 8));
  // Fit category labels to the space each one gets (about 6.5 units per character).
  const maxChars = Math.max(4, Math.floor(((w - pad.l - pad.r) / Math.ceil(n / step)) / 6.5));

  return (
    <div className="ss-chart-wrap">
      {spec.series.length > 1 && (
        <div className="ss-legend ss-chart-legend">
          {spec.series.map((s, si) => (
            <span key={si}>
              <i style={{ background: SERIES_COLORS[si % SERIES_COLORS.length] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg ref={ref} className="ss-chart" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={spec.title ?? "Chart"} {...handlers}>
        {[min, (max + min) / 2, max].map((t, k) => (
          <g key={k}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} style={GRID} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" style={INK}>
              {fmtNum(t)}
            </text>
          </g>
        ))}
        {hi !== null && spec.type === "bar" && <rect x={pad.l + hi * slot} y={pad.t} width={slot} height={h - pad.t - pad.b} style={{ fill: "var(--ss-neutral-bg)" }} />}
        {spec.type === "bar"
          ? spec.series.map((s, si) =>
              s.values.map((v, i) => (
                <rect
                  key={`${si}-${i}`}
                  x={pad.l + i * slot + slot * 0.14 + si * barW}
                  y={Math.min(y(v), y(0))}
                  width={barW * 0.92}
                  height={Math.max(2, Math.abs(y(0) - y(v)))}
                  rx={3}
                  style={{ fill: SERIES_COLORS[si % SERIES_COLORS.length] }}
                  opacity={hi !== null && hi !== i ? 0.55 : 1}
                />
              )),
            )
          : spec.series.map((s, si) => (
              <path
                key={si}
                d={smoothPath(
                  s.values.map((v, i) => [cx(i), y(v)] as [number, number]),
                  y(min),
                  y(max),
                )}
                fill="none"
                style={{ stroke: SERIES_COLORS[si % SERIES_COLORS.length] }}
                strokeWidth={2.2}
              />
            ))}
        {spec.labels.map((l, i) =>
          i % step === 0 ? (
            <text key={i} x={cx(i)} y={h - 14} textAnchor="middle" style={INK}>
              {l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l}
            </text>
          ) : null,
        )}
        {hi !== null && spec.type === "line" && (
          <g pointerEvents="none">
            <line x1={cx(hi)} x2={cx(hi)} y1={pad.t} y2={h - pad.b} style={{ stroke: "var(--ss-text-2)" }} opacity={0.5} />
            {spec.series.map((s, si) => (
              <circle key={si} cx={cx(hi)} cy={y(s.values[hi] ?? 0)} r={5} style={{ fill: "var(--ss-surface)", stroke: SERIES_COLORS[si % SERIES_COLORS.length] }} strokeWidth={2.5} />
            ))}
          </g>
        )}
      </svg>
      {hi !== null && hover && (
        <Tooltip x={cx(hi) / w}>
          <div className="ss-tip-title">{spec.labels[hi]}</div>
          {spec.series.map((s, si) => (
            <TipRow key={s.name} color={SERIES_COLORS[si % SERIES_COLORS.length]} label={s.name} value={`${fmtNum(s.values[hi] ?? 0, 1)}${spec.unit ? ` ${spec.unit}` : ""}`} />
          ))}
        </Tooltip>
      )}
    </div>
  );
}
