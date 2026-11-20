import { Link } from "react-router";
import { StockCurve } from "./charts";
import { Badge, StatusBadge } from "./ui";
import { num } from "../lib/format";

export interface SpotlightData {
  variantId: string;
  shortId: string;
  label: string;
  sku: string | null;
  status: string;
  onHand: number;
  onOrder: number;
  dailyRate14: number;
  leadTimeDays: number;
  reorderPoint: number;
  suggestedQty: number;
  past: number[];
  future: number[];
  crossingDay: number | null;
  leadTimeDay: number;
  today: string;
  summary: string;
}

/** Live "projected units on hand" card for one SKU, with arrows to step through others. */
export function SpotlightCard({
  data,
  prevHref,
  nextHref,
  position,
}: {
  data: SpotlightData;
  prevHref?: string;
  nextHref?: string;
  position?: string;
}) {
  return (
    <section className="ss-card ss-spot">
      <div className="ss-card-head">
        <h2 className="ss-card-title" style={{ minWidth: 0 }}>
          <span className="ss-dot" />
          <span className="ss-spot-title">
            {data.sku ? `${data.sku} · ` : ""}
            {data.label}
          </span>
        </h2>
        <div className="ss-spot-nav">
          <StatusBadge status={data.status} />
          {position && (
            <>
              {prevHref ? (
                <Link
                  to={prevHref}
                  preventScrollReset
                  aria-label="Previous SKU"
                >
                  ‹
                </Link>
              ) : (
                <span aria-hidden="true">‹</span>
              )}
              <span className="ss-card-meta">{position}</span>
              {nextHref ? (
                <Link to={nextHref} preventScrollReset aria-label="Next SKU">
                  ›
                </Link>
              ) : (
                <span aria-hidden="true">›</span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="ss-card-body">
        <div style={{ marginBottom: 6 }}>
          <div className="ss-strong">Projected units on hand</div>
          <div className="ss-card-sub">{data.summary}</div>
        </div>
        <StockCurve
          past={data.past}
          now={data.onHand}
          future={data.future}
          reorderPoint={data.reorderPoint}
          crossingDay={data.crossingDay}
          today={data.today}
          height={170}
        />
        <div className="ss-list" style={{ marginTop: 8 }}>
          <div className="ss-list-row">
            <span className="ss-stat-label">Units on hand</span>
            <span className="ss-mono">
              {num(data.onHand)}
              {data.onOrder ? (
                <span className="ss-muted"> +{num(data.onOrder)}</span>
              ) : null}
            </span>
          </div>
          <div className="ss-list-row">
            <span className="ss-stat-label">Daily rate, 14-day avg</span>
            <span className="ss-mono">{num(data.dailyRate14, 1)}</span>
          </div>
          <div className="ss-list-row">
            <span className="ss-stat-label">Supplier lead time</span>
            <span className="ss-mono">
              {Math.round(data.leadTimeDays)} days
            </span>
          </div>
          <div className="ss-list-row">
            <span className="ss-stat-label">Suggested order</span>
            {data.suggestedQty ? (
              <Badge tone="accent">{`${num(data.suggestedQty)} units`}</Badge>
            ) : (
              <span className="ss-muted ss-small">none needed</span>
            )}
          </div>
        </div>
      </div>
      <div className="ss-card-foot">
        <div className="ss-row between">
          <span className="ss-card-meta">
            reorder point {num(data.reorderPoint)}
          </span>
          <Link
            className="ss-link ss-small"
            to={`/app/forecasts/${data.shortId}`}
          >
            Open forecast →
          </Link>
        </div>
      </div>
    </section>
  );
}
