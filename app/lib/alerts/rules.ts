// Alert rules. Pure functions so they are easy to test.
// An alert for every low SKU is noise, so rules only fire when there is still time to
// act, and each alert carries a fingerprint: the merchant is only interrupted again
// when the fingerprint changes (for example a warning escalates to critical).

import { coverLabel } from "../format";

export type AlertType = "STOCKOUT_RISK" | "REORDER_POINT" | "VELOCITY_SHIFT" | "LEAD_TIME_DRIFT" | "OVERSTOCK";
export type Severity = "CRITICAL" | "WARNING" | "INFO";

export interface AlertCandidate {
  type: AlertType;
  severity: Severity;
  variantId?: string;
  supplierId?: string;
  locationId: string;
  title: string;
  message: string;
  revenueAtRisk: number;
  dedupeKey: string;
  fingerprint: string;
}

export interface ForecastView {
  variantId: string;
  locationId: string;
  label: string;
  onHand: number;
  onOrder: number;
  daysOfCover: number;
  leadTimeDays: number;
  suggestedQty: number;
  revenueAtRisk: number;
  overstockValue: number;
  status: string;
  meanDaily: number;
  sigmaDaily: number;
  hasDraftPo: boolean;
}

export function stockRules(f: ForecastView, currencyFmt: (n: number) => string): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const loc = f.locationId;
  const key = (t: AlertType) => `${t}:${f.variantId}:${loc}`;
  const cover = coverLabel(f.daysOfCover);

  if (f.status === "REORDER_NOW" && f.daysOfCover < f.leadTimeDays) {
    out.push({
      type: "STOCKOUT_RISK",
      severity: "CRITICAL",
      variantId: f.variantId,
      locationId: loc,
      title: f.label,
      message: `${f.onHand} units left, ${cover} of cover at current rate. Supplier needs ${Math.round(f.leadTimeDays)} days, so a normal order lands after it sells out.`,
      revenueAtRisk: f.revenueAtRisk,
      dedupeKey: key("STOCKOUT_RISK"),
      fingerprint: "CRITICAL",
    });
  } else if (f.status === "REORDER_NOW") {
    out.push({
      type: "REORDER_POINT",
      severity: "WARNING",
      variantId: f.variantId,
      locationId: loc,
      title: f.label,
      message: f.hasDraftPo
        ? `Reorder point reached, draft PO ready (${f.suggestedQty} units).`
        : `Reorder point reached. Suggested order: ${f.suggestedQty} units.`,
      revenueAtRisk: f.revenueAtRisk,
      dedupeKey: key("REORDER_POINT"),
      fingerprint: f.hasDraftPo ? "DRAFT" : "NO_DRAFT",
    });
  }

  if (f.status === "OVERSTOCKED" && f.overstockValue >= 100) {
    out.push({
      type: "OVERSTOCK",
      severity: "INFO",
      variantId: f.variantId,
      locationId: loc,
      title: f.label,
      message:
        f.meanDaily <= 0
          ? `No sales expected in the forecast window. ${f.onHand} units, about ${currencyFmt(f.overstockValue)} at cost, sitting idle.`
          : `Overstocked with ${cover} of cover. About ${currencyFmt(f.overstockValue)} tied up above target.`,
      revenueAtRisk: 0,
      dedupeKey: key("OVERSTOCK"),
      fingerprint: "OVERSTOCK",
    });
  }
  return out;
}

/**
 * A SKU selling well outside its forecast band fires the same day rather than
 * waiting for the next rebuild. Compares the last 3 days (including today so far)
 * with the expected rate for those 3 days.
 */
export function velocityRule(
  f: ForecastView,
  actual3: number,
  baselineDaily: number | null,
  sinceDayName: string,
  threshold: number,
  price: number,
): AlertCandidate | null {
  // Compare with the normal rate before the window, so a spike that a rebuild has
  // already absorbed into the forecast still counts as a shift.
  const expected = (baselineDaily !== null && baselineDaily > 0 ? Math.min(baselineDaily, f.meanDaily || baselineDaily) : f.meanDaily) * 3;
  if (expected < 1 && actual3 < 4) return null;
  const band = 2 * f.sigmaDaily * Math.sqrt(3);
  const ratio = expected > 0 ? actual3 / expected : Infinity;
  const key = `VELOCITY_SHIFT:${f.variantId}:${f.locationId}`;
  if (ratio >= threshold && actual3 - expected > band) {
    const shown = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "well above";
    const extraDaily = actual3 / 3 - f.meanDaily;
    return {
      type: "VELOCITY_SHIFT",
      severity: f.daysOfCover < f.leadTimeDays * 1.5 ? "CRITICAL" : "WARNING",
      variantId: f.variantId,
      locationId: f.locationId,
      title: f.label,
      message: `Selling ${shown} faster than forecast since ${sinceDayName}. At this pace cover drops to ${coverLabel(
        f.onHand / Math.max(0.01, actual3 / 3),
      )}.`,
      revenueAtRisk: Math.max(f.revenueAtRisk, extraDaily * f.leadTimeDays * price),
      dedupeKey: key,
      fingerprint: `UP:${Math.floor(ratio)}`,
    };
  }
  if (expected >= 5 && ratio <= 1 / threshold && expected - actual3 > band) {
    return {
      type: "VELOCITY_SHIFT",
      severity: "INFO",
      variantId: f.variantId,
      locationId: f.locationId,
      title: f.label,
      message: `Selling ${(1 / Math.max(ratio, 0.01)).toFixed(1)}x slower than forecast since ${sinceDayName}. Check open orders before they land.`,
      revenueAtRisk: 0,
      dedupeKey: key,
      fingerprint: "DOWN",
    };
  }
  return null;
}

/** When a supplier quietly gets slower (or faster), say so the morning it happens. */
export function leadTimeRule(
  supplier: { supplierId: string; name: string; latest: number | null; previous: number | null },
  revenueAtRisk: number,
): AlertCandidate | null {
  const { latest, previous } = supplier;
  if (latest === null || previous === null) return null;
  const delta = latest - previous;
  if (Math.abs(delta) < Math.max(3, previous * 0.3)) return null;
  const slower = delta > 0;
  return {
    type: "LEAD_TIME_DRIFT",
    severity: slower ? "WARNING" : "INFO",
    supplierId: supplier.supplierId,
    locationId: "",
    title: supplier.name,
    message: `Supplier lead time moved ${Math.round(previous)} to ${Math.round(latest)} days. ${
      slower ? "Forecasts and reorder points for its SKUs have moved with it." : "Reorder points have come down."
    }`,
    revenueAtRisk: slower ? revenueAtRisk : 0,
    dedupeKey: `LEAD_TIME_DRIFT:${supplier.supplierId}`,
    fingerprint: `${Math.round(previous)}->${Math.round(latest)}`,
  };
}

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  STOCKOUT_RISK: "Stockout risk",
  REORDER_POINT: "Reorder point",
  VELOCITY_SHIFT: "Velocity shift",
  LEAD_TIME_DRIFT: "Lead-time drift",
  OVERSTOCK: "Overstock",
};
