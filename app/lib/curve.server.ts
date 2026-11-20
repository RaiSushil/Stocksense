// Stock curve for one variant: the last few weeks of units on hand (rebuilt from
// sales and received purchase orders) joined to the projected units on hand from
// the latest forecast, with where it crosses the reorder point and hits zero.

import db from "../db.server";
import { addDays, diffDays, todayIn } from "./dates";
import { planInventory } from "./forecast/inventory";
import { variantLabel } from "./format";

export interface StockCurve {
  variantId: string;
  label: string;
  sku: string | null;
  status: string;
  onHand: number;
  onOrder: number;
  dailyRate14: number;
  leadTimeDays: number;
  reorderPoint: number;
  suggestedQty: number;
  daysOfCover: number;
  /** Units on hand at the end of each past day, oldest first. */
  past: number[];
  /** Projected units on hand at the end of each day from today. */
  future: number[];
  futureLow: number[];
  futureHigh: number[];
  /** Days from today when stock crosses below the reorder point (negative = already crossed). */
  crossingDay: number | null;
  /** True when stock was already below the reorder point for the whole past window. */
  belowWholeWindow: boolean;
  /** Days from today until projected stock reaches zero (null = not within the window). */
  zeroDay: number | null;
  /** Day index where an order placed today would arrive. */
  leadTimeDay: number;
  /** Today in the shop timezone (YYYY-MM-DD), for tooltip dates. */
  today: string;
}

export async function stockCurve(
  shop: string,
  variantId: string,
  opts: { pastDays?: number; minFuture?: number; maxFuture?: number } = {},
): Promise<StockCurve | null> {
  const pastDays = opts.pastDays ?? 14;
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const today = todayIn(shopRow.timezone);
  const [variant, f] = await Promise.all([
    db.variant.findFirst({ where: { shop, id: variantId } }),
    db.forecast.findUnique({ where: { variantId_locationId: { variantId, locationId: "" } } }),
  ]);
  if (!variant || !f) return null;

  // Past: walk back from today's stock, adding back what was sold and removing
  // what was received from purchase orders on each day.
  const since = addDays(today, -pastDays + 1);
  const [sales, receipts, openLines] = await Promise.all([
    db.salesDaily.groupBy({ by: ["date"], where: { variantId, date: { gte: since } }, _sum: { units: true } }),
    db.purchaseOrderLine.findMany({
      where: { variantId, receivedQty: { gt: 0 }, po: { shop, receivedAt: { gte: new Date(`${since}T00:00:00Z`) } } },
      include: { po: true },
    }),
    db.purchaseOrderLine.findMany({
      where: { variantId, po: { shop, status: { in: ["APPROVED", "SENT", "PARTIAL"] } } },
      include: { po: true },
    }),
  ]);
  const soldOn = new Map(sales.map((s) => [s.date, s._sum.units ?? 0]));
  const receivedOn = new Map<string, number>();
  for (const r of receipts) {
    const d = r.po.receivedAt!.toISOString().slice(0, 10);
    receivedOn.set(d, (receivedOn.get(d) ?? 0) + r.receivedQty);
  }
  const past: number[] = [];
  let stock = f.onHand;
  for (let k = 0; k < pastDays; k++) {
    const day = addDays(today, -k);
    // Stock at the end of the previous day = stock now + sold that day - received that day.
    stock = stock + (soldOn.get(day) ?? 0) - (receivedOn.get(day) ?? 0);
    past.unshift(Math.max(0, stock));
  }

  // Future: the same projection the forecast uses, with open POs landing on their date.
  const series: number[] = JSON.parse(f.series);
  const lower: number[] = JSON.parse(f.lower);
  const upper: number[] = JSON.parse(f.upper);
  const incoming = openLines
    .map((l) => ({
      qty: Math.max(0, l.quantity - l.receivedQty),
      day: l.po.expectedAt ? Math.max(0, diffDays(l.po.expectedAt.toISOString().slice(0, 10), today)) : Math.ceil(f.leadTimeDays),
    }))
    .filter((i) => i.qty > 0);
  const plan = planInventory({
    mean: series,
    sigmaDaily: f.sigmaDaily,
    onHand: f.onHand,
    incoming,
    leadTimeDays: f.leadTimeDays,
    leadTimeStdDays: 0,
    serviceLevel: shopRow.serviceLevel,
    coverageDays: shopRow.coverageDays,
    overstockDays: shopRow.overstockDays,
    price: variant.price,
    unitCost: variant.unitCost,
    casePack: variant.casePack,
    minOrderQty: variant.minOrderQty,
  });

  const zeroAt = plan.projection.findIndex((v) => v <= 0);
  const leadTimeDay = Math.ceil(f.leadTimeDays);
  // Show at least past the lead time, and a week past the stockout if there is one.
  const wanted = Math.max(opts.minFuture ?? 21, leadTimeDay + 5, zeroAt >= 0 ? zeroAt + 7 : 0);
  const futureDays = Math.min(opts.maxFuture ?? 60, wanted, plan.projection.length);
  const future = plan.projection.slice(0, futureDays);

  // 80% band on projected stock: on hand plus arrivals minus cumulative high or low demand.
  const futureLow: number[] = [];
  const futureHigh: number[] = [];
  let cumLow = 0;
  let cumHigh = 0;
  let arrived = 0;
  for (let i = 0; i < futureDays; i++) {
    arrived += incoming.filter((x) => x.day === i).reduce((a, x) => a + x.qty, 0);
    cumLow += lower[i] ?? 0;
    cumHigh += upper[i] ?? 0;
    futureHigh.push(Math.max(0, f.onHand + arrived - cumLow));
    futureLow.push(Math.max(0, f.onHand + arrived - cumHigh));
  }

  // First drop below the reorder point across past + now + future.
  const all = [...past, f.onHand, ...future];
  const rop = f.reorderPoint;
  let crossing: number | null = null;
  for (let i = 1; i < all.length; i++) {
    if (all[i - 1] >= rop && all[i] < rop) {
      crossing = i;
      break;
    }
  }
  const belowWholeWindow = crossing === null && all[0] < rop;

  return {
    variantId,
    label: variantLabel(variant),
    sku: variant.sku,
    status: f.status,
    onHand: f.onHand,
    onOrder: f.onOrder,
    dailyRate14: f.dailyRate14,
    leadTimeDays: f.leadTimeDays,
    reorderPoint: rop,
    suggestedQty: f.suggestedQty,
    daysOfCover: f.daysOfCover,
    past,
    future,
    futureLow,
    futureHigh,
    // Index pastDays in `all` is "now".
    crossingDay: crossing !== null ? crossing - pastDays : null,
    belowWholeWindow,
    zeroDay: zeroAt >= 0 ? zeroAt : null,
    leadTimeDay,
    today,
  };
}

/** Variants worth putting in the spotlight: most revenue at risk first. */
export async function spotlightCandidates(shop: string, limit = 6) {
  const atRisk = await db.forecast.findMany({
    where: { shop, locationId: "", status: { in: ["REORDER_NOW", "WATCH"] }, meanDaily: { gt: 0 } },
    orderBy: [{ revenueAtRisk: "desc" }, { daysOfCover: "asc" }],
    take: limit,
  });
  const rows = atRisk.length
    ? atRisk
    : await db.forecast.findMany({
        where: { shop, locationId: "", meanDaily: { gt: 0 } },
        orderBy: { meanDaily: "desc" },
        take: limit,
      });
  const variants = new Map((await db.variant.findMany({ where: { id: { in: rows.map((r) => r.variantId) } } })).map((v) => [v.id, v]));
  return rows.map((r) => ({ variantId: r.variantId, sku: variants.get(r.variantId)?.sku ?? null }));
}

/** One-line summary for the card subtitle, e.g. "Reaches zero in 6 days. Reorder point crossed 2 days ago." */
export function curveSummary(c: StockCurve, windowPast: number): string {
  const parts: string[] = [];
  if (c.zeroDay !== null) parts.push(c.zeroDay <= 0 ? "Out of stock today." : `Reaches zero in ${c.zeroDay} day${c.zeroDay === 1 ? "" : "s"}.`);
  else parts.push(`Covered for the next ${c.future.length} days.`);
  if (c.crossingDay !== null) {
    const d = c.crossingDay;
    parts.push(
      d < 0
        ? `Reorder point crossed ${-d} day${d === -1 ? "" : "s"} ago.`
        : d === 0
          ? "Reorder point crossed today."
          : `Crosses the reorder point in ${d} day${d === 1 ? "" : "s"}.`,
    );
  } else if (c.belowWholeWindow) {
    parts.push(`Below the reorder point for ${windowPast}+ days.`);
  }
  if (c.zeroDay !== null && c.zeroDay < c.leadTimeDay) parts.push("An order placed today lands after it sells out.");
  return parts.join(" ");
}
