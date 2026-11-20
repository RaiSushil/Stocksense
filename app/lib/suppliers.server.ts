// Supplier lead times and scorecards.
// Lead time = rolling 90 day average of observed lead times (received purchase orders
// and manual updates), or the latest one if it is slower, falling back to the
// supplier's default when nothing has been observed.

import db from "../db.server";
import { mean, std } from "./forecast/stats";

export interface LeadTimeStats {
  supplierId: string;
  name: string;
  effective: number; // what forecasts use
  std: number;
  observations: number;
  latest: number | null;
  previous: number | null; // average before the latest observation, for drift detection
  latestAt: Date | null;
  defaultDays: number;
}

const WINDOW_DAYS = 90;

export async function leadTimeStats(shop: string): Promise<Map<string, LeadTimeStats>> {
  const since = new Date(Date.now() - 2 * WINDOW_DAYS * 86_400_000);
  const suppliers = await db.supplier.findMany({
    where: { shop },
    include: { leadTimes: { where: { observedAt: { gte: since } }, orderBy: { observedAt: "asc" } } },
  });
  const out = new Map<string, LeadTimeStats>();
  const windowStart = Date.now() - WINDOW_DAYS * 86_400_000;
  for (const s of suppliers) {
    const recent = s.leadTimes.filter((o) => o.observedAt.getTime() >= windowStart).map((o) => o.days);
    const all = s.leadTimes.map((o) => o.days);
    const latestObs = s.leadTimes[s.leadTimes.length - 1];
    const before = all.slice(0, -1);
    // Rolling 90-day average, but when the latest delivery (within 30 days) was slower,
    // plan on the slower number straight away: a supplier that slipped from 9 to 21
    // days moves every forecast behind it the morning it happens.
    const avg = recent.length ? mean(recent) : s.defaultLeadTimeDays;
    const latestRecent =
      latestObs && Date.now() - latestObs.observedAt.getTime() <= 30 * 86_400_000 ? latestObs.days : null;
    const effective = latestRecent !== null && latestRecent > avg ? latestRecent : avg;
    out.set(s.id, {
      supplierId: s.id,
      name: s.name,
      effective,
      std: recent.length >= 2 ? std(recent) : effective * 0.2,
      observations: recent.length,
      latest: latestObs?.days ?? null,
      previous: before.length ? mean(before.slice(-3)) : latestObs ? s.defaultLeadTimeDays : null,
      latestAt: latestObs?.observedAt ?? null,
      defaultDays: s.defaultLeadTimeDays,
    });
  }
  return out;
}

/** Record a manual lead time change so forecasts and drift alerts pick it up. */
export async function setSupplierLeadTime(shop: string, supplierId: string, days: number) {
  const supplier = await db.supplier.findFirstOrThrow({ where: { id: supplierId, shop } });
  if (supplier.defaultLeadTimeDays === days) return supplier;
  const [updated] = await db.$transaction([
    db.supplier.update({ where: { id: supplierId }, data: { defaultLeadTimeDays: days } }),
    db.leadTimeObservation.create({ data: { shop, supplierId, days, source: "MANUAL" } }),
  ]);
  return updated;
}

export interface Scorecard {
  supplierId: string;
  name: string;
  purchaseOrders: number;
  received: number;
  onTimeRate: number | null;
  avgLeadTime: number | null;
  leadTimeSpread: number | null;
  fillRate: number | null;
  spend: number;
  openValue: number;
}

export async function supplierScorecards(shop: string): Promise<Scorecard[]> {
  const suppliers = await db.supplier.findMany({
    where: { shop },
    include: { purchaseOrders: { include: { lines: true } } },
    orderBy: { name: "asc" },
  });
  return suppliers.map((s) => {
    const pos = s.purchaseOrders.filter((p) => p.status !== "CANCELLED" && p.status !== "DRAFT");
    const received = pos.filter((p) => p.receivedAt && p.orderedAt);
    const leadTimes = received.map((p) => (p.receivedAt!.getTime() - p.orderedAt!.getTime()) / 86_400_000);
    const withExpected = received.filter((p) => p.expectedAt);
    const onTime = withExpected.filter((p) => p.receivedAt!.getTime() <= p.expectedAt!.getTime() + 86_400_000);
    let ordered = 0;
    let got = 0;
    let spend = 0;
    let openValue = 0;
    for (const p of pos) {
      for (const l of p.lines) {
        if (p.status === "RECEIVED" || p.status === "PARTIAL") {
          ordered += l.quantity;
          got += Math.min(l.receivedQty, l.quantity);
        }
        spend += l.receivedQty * l.unitCost;
        if (["APPROVED", "SENT", "PARTIAL"].includes(p.status)) openValue += Math.max(0, l.quantity - l.receivedQty) * l.unitCost;
      }
    }
    return {
      supplierId: s.id,
      name: s.name,
      purchaseOrders: pos.length,
      received: received.length,
      onTimeRate: withExpected.length ? onTime.length / withExpected.length : null,
      avgLeadTime: leadTimes.length ? mean(leadTimes) : null,
      leadTimeSpread: leadTimes.length >= 2 ? std(leadTimes) : null,
      fillRate: ordered ? got / ordered : null,
      spend,
      openValue,
    };
  });
}
