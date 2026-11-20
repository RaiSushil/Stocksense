// Rebuilds every forecast for a shop: loads history, inventory, open purchase orders,
// promotions and supplier lead times, then runs the engine per variant and per location.

import db from "../../db.server";
import { addDays, diffDays, todayIn } from "../dates";
import { hasFeature, skuLimit } from "../plans";
import { leadTimeStats } from "../suppliers.server";
import { forecastDemand } from "./engine";
import { planInventory, type IncomingStock } from "./inventory";
import { HISTORY_DAYS } from "../sync/orders.server";

const OPEN_PO = ["APPROVED", "SENT", "PARTIAL"];

export interface RebuildSummary {
  variants: number;
  forecasted: number;
  skipped: number;
  accuracy: number | null;
}

/**
 * Rebuild forecasts for the whole shop, or only for `variantIds` (used right after
 * an order or a stock change, so the dashboard reflects it within seconds).
 */
export async function rebuildForecasts(shop: string, opts: { variantIds?: string[] } = {}): Promise<RebuildSummary> {
  const partial = opts.variantIds ? new Set(opts.variantIds) : null;
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const today = todayIn(shopRow.timezone);
  const historyStart = addDays(today, -HISTORY_DAYS);
  const historyLen = HISTORY_DAYS; // historyStart .. yesterday

  const variants = await db.variant.findMany({ where: { shop, status: { in: ["ACTIVE", "DRAFT"] }, tracked: true } });
  const locations = await db.location.findMany({ where: { shop, isActive: true } });
  const multiLocation = hasFeature(shopRow.plan, "multiLocation") && locations.length > 1;
  const leadTimes = await leadTimeStats(shop);
  const promotions = await db.promotion.findMany({ where: { shop, endDate: { gte: today } } });

  // Rank by trailing 90 day revenue so the SKU limit keeps the variants that matter.
  const revenue90 = await db.salesDaily.groupBy({
    by: ["variantId"],
    where: { shop, date: { gte: addDays(today, -90) } },
    _sum: { revenue: true, units: true },
  });
  const revByVariant = new Map(revenue90.map((r) => [r.variantId, r._sum.revenue ?? 0]));
  const levels = await db.inventoryLevel.findMany({ where: { shop } });
  const levelsByVariant = new Map<string, typeof levels>();
  for (const l of levels) {
    const arr = levelsByVariant.get(l.variantId) ?? [];
    arr.push(l);
    levelsByVariant.set(l.variantId, arr);
  }
  // Variants you actively sell: sold in the last year or holding stock.
  const soldLastYear = new Set(
    (
      await db.salesDaily.groupBy({ by: ["variantId"], where: { shop, date: { gte: addDays(today, -365) }, units: { gt: 0 } } })
    ).map((r) => r.variantId),
  );
  const active = variants.filter(
    (v) => soldLastYear.has(v.id) || (levelsByVariant.get(v.id) ?? []).some((l) => l.available > 0),
  );
  active.sort((a, b) => (revByVariant.get(b.id) ?? 0) - (revByVariant.get(a.id) ?? 0));
  const limit = shopRow.plan === "NONE" ? 500 : skuLimit(shopRow.plan);
  const withinLimit = active.slice(0, Number.isFinite(limit) ? limit : undefined);
  const selected = partial ? withinLimit.filter((v) => partial.has(v.id)) : withinLimit;

  const openLines = await db.purchaseOrderLine.findMany({
    where: { po: { shop, status: { in: OPEN_PO } } },
    include: { po: true },
  });
  const linesByVariant = new Map<string, typeof openLines>();
  for (const l of openLines) {
    const arr = linesByVariant.get(l.variantId) ?? [];
    arr.push(l);
    linesByVariant.set(l.variantId, arr);
  }

  const rows: any[] = [];
  const accuracyWeights: { acc: number; w: number }[] = [];

  const CHUNK = 300;
  for (let c = 0; c < selected.length; c += CHUNK) {
    const chunk = selected.slice(c, c + CHUNK);
    const sales = await db.salesDaily.findMany({
      where: { variantId: { in: chunk.map((v) => v.id) }, date: { gte: historyStart, lte: today } },
    });
    const salesByVariant = new Map<string, typeof sales>();
    for (const s of sales) {
      const arr = salesByVariant.get(s.variantId) ?? [];
      arr.push(s);
      salesByVariant.set(s.variantId, arr);
    }

    for (const v of chunk) {
      const vSales = salesByVariant.get(v.id) ?? [];
      const total = new Array(historyLen).fill(0);
      const discount = new Array(historyLen).fill(0);
      const byLocation = new Map<string, number[]>();
      let todayUnits = 0;
      for (const s of vSales) {
        if (s.date === today) {
          todayUnits += s.units;
          continue;
        }
        const idx = diffDays(s.date, historyStart);
        if (idx < 0 || idx >= historyLen) continue;
        total[idx] += s.units;
        discount[idx] += s.discountUnits;
        if (multiLocation) {
          const arr = byLocation.get(s.locationId) ?? new Array(historyLen).fill(0);
          arr[idx] += s.units;
          byLocation.set(s.locationId, arr);
        }
      }
      const promoDays = total.map((u, i) => u > 0 && discount[i] / u >= 0.5);

      const supplierStats = v.supplierId ? leadTimes.get(v.supplierId) : undefined;
      const leadTimeDays = v.leadTimeOverride ?? supplierStats?.effective ?? shopRow.defaultLeadTimeDays;
      const leadTimeStd = v.leadTimeOverride ? v.leadTimeOverride * 0.15 : supplierStats?.std ?? leadTimeDays * 0.2;
      const horizon = Math.max(120, Math.ceil(leadTimeDays) + shopRow.coverageDays + 14, shopRow.overstockDays + 7);
      const uplift = upliftFor(v, promotions, today, horizon);

      // The model learns from completed days. The one exception is a variant whose
      // first ever sales happened today: use today so it gets a forecast straight away
      // instead of waiting until tomorrow.
      const firstSalesToday = todayUnits > 0 && total.every((u) => u === 0);
      const fc = firstSalesToday
        ? forecastDemand({ history: [...total, todayUnits], historyStart, futureUplift: uplift, horizon })
        : forecastDemand({ history: total, historyStart, promoDays, futureUplift: uplift, horizon });
      const vLevels = levelsByVariant.get(v.id) ?? [];
      const onHand = vLevels.reduce((s, l) => s + Math.max(0, l.available), 0);
      const incoming = incomingFor(linesByVariant.get(v.id) ?? [], today, leadTimeDays);

      const plan = planInventory({
        mean: fc.mean,
        sigmaDaily: fc.sigmaDaily,
        onHand,
        incoming,
        leadTimeDays,
        leadTimeStdDays: leadTimeStd,
        serviceLevel: shopRow.serviceLevel,
        coverageDays: shopRow.coverageDays,
        overstockDays: shopRow.overstockDays,
        price: v.price,
        unitCost: v.unitCost,
        casePack: v.casePack,
        minOrderQty: v.minOrderQty,
      });
      // A variant that has never sold is not overstock, it simply has no sales yet.
      if (fc.method === "NO_DATA") {
        plan.status = "NO_DATA";
        plan.overstockUnits = 0;
        plan.overstockValue = 0;
      }
      rows.push(toRow(shop, v.id, "", fc, plan, onHand, leadTimeDays, today));
      if (fc.accuracy !== null) accuracyWeights.push({ acc: fc.accuracy, w: Math.max(1, revByVariant.get(v.id) ?? 0) });

      if (multiLocation) {
        // Online orders that were not attributed to a location are shared out in
        // proportion to each location's attributed sales, or its stock if it has none.
        const unattributed = byLocation.get("") ?? new Array(historyLen).fill(0);
        const attributedTotals = locations.map((l) => sumArr(byLocation.get(l.id)));
        const stockTotals = locations.map((l) => Math.max(0, vLevels.find((x) => x.locationId === l.id)?.available ?? 0));
        const attrSum = attributedTotals.reduce((a, b) => a + b, 0);
        const stockSum = stockTotals.reduce((a, b) => a + b, 0);
        locations.forEach((loc, li) => {
          const level = vLevels.find((x) => x.locationId === loc.id);
          if (!level) return; // variant not stocked here
          const share = attrSum > 0 ? attributedTotals[li] / attrSum : stockSum > 0 ? stockTotals[li] / stockSum : 1 / locations.length;
          const own = byLocation.get(loc.id) ?? new Array(historyLen).fill(0);
          const series = own.map((u, i) => u + unattributed[i] * share);
          const lfc = forecastDemand({ history: series, historyStart, futureUplift: uplift, horizon, skipBacktest: true });
          const lIncoming = incomingFor(
            (linesByVariant.get(v.id) ?? []).filter((l) => !l.po.locationId || l.po.locationId === loc.id),
            today,
            leadTimeDays,
          );
          const lplan = planInventory({
            mean: lfc.mean,
            sigmaDaily: lfc.sigmaDaily,
            onHand: Math.max(0, level.available),
            incoming: lIncoming,
            leadTimeDays,
            leadTimeStdDays: leadTimeStd,
            serviceLevel: shopRow.serviceLevel,
            coverageDays: shopRow.coverageDays,
            overstockDays: shopRow.overstockDays,
            price: v.price,
            unitCost: v.unitCost,
            casePack: v.casePack,
            minOrderQty: v.minOrderQty,
          });
          if (fc.method === "NO_DATA") {
            lplan.status = "NO_DATA";
            lplan.overstockUnits = 0;
            lplan.overstockValue = 0;
          }
          rows.push(toRow(shop, v.id, loc.id, lfc, lplan, Math.max(0, level.available), leadTimeDays, today));
        });
      }
    }
  }

  if (partial) {
    await db.$transaction([
      db.forecast.deleteMany({ where: { shop, variantId: { in: [...partial] } } }),
      ...chunked(rows, 200).map((data) => db.forecast.createMany({ data })),
    ]);
    // A partial refresh does not move the shop-wide accuracy or the rebuild schedule.
    return { variants: active.length, forecasted: selected.length, skipped: 0, accuracy: null };
  }

  await db.$transaction([
    db.forecast.deleteMany({ where: { shop } }),
    ...chunked(rows, 200).map((data) => db.forecast.createMany({ data })),
  ]);

  const wSum = accuracyWeights.reduce((s, a) => s + a.w, 0);
  const accuracy = wSum > 0 ? accuracyWeights.reduce((s, a) => s + a.acc * a.w, 0) / wSum : null;
  if (accuracy !== null) {
    await db.accuracySnapshot.upsert({
      where: { shop_date: { shop, date: today } },
      create: { shop, date: today, accuracy, skuCount: accuracyWeights.length },
      update: { accuracy, skuCount: accuracyWeights.length },
    });
  }
  await db.shop.update({ where: { id: shop }, data: { lastForecastAt: new Date() } });
  return { variants: active.length, forecasted: selected.length, skipped: active.length - selected.length, accuracy };
}

function toRow(
  shop: string,
  variantId: string,
  locationId: string,
  fc: ReturnType<typeof forecastDemand>,
  plan: ReturnType<typeof planInventory>,
  onHand: number,
  leadTimeDays: number,
  today: string,
) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    shop,
    variantId,
    locationId,
    method: fc.method,
    historyDays: fc.historyDays,
    dailyRate14: r2(fc.dailyRate14),
    meanDaily: r2(fc.meanDaily),
    sigmaDaily: r2(fc.sigmaDaily),
    series: JSON.stringify(fc.mean.map(r2)),
    lower: JSON.stringify(fc.lower.map(r2)),
    upper: JSON.stringify(fc.upper.map(r2)),
    onHand,
    onOrder: plan.onOrder,
    leadTimeDays: r2(leadTimeDays),
    safetyStock: r2(plan.safetyStock),
    reorderPoint: r2(plan.reorderPoint),
    daysOfCover: r2(plan.daysOfCover),
    stockoutDate: plan.stockoutDay !== null ? addDays(today, Math.floor(plan.stockoutDay)) : null,
    suggestedQty: plan.suggestedQty,
    revenueAtRisk: r2(plan.revenueAtRisk),
    overstockUnits: r2(plan.overstockUnits),
    overstockValue: r2(plan.overstockValue),
    status: plan.status,
    confidence: fc.confidence,
    accuracy: fc.accuracy,
  };
}

export function incomingFor(
  lines: { quantity: number; receivedQty: number; po: { expectedAt: Date | null } }[],
  today: string,
  leadTimeDays: number,
): IncomingStock[] {
  return lines
    .map((l) => ({
      qty: Math.max(0, l.quantity - l.receivedQty),
      day: l.po.expectedAt
        ? Math.max(0, diffDays(l.po.expectedAt.toISOString().slice(0, 10), today))
        : Math.ceil(leadTimeDays),
    }))
    .filter((i) => i.qty > 0);
}

function upliftFor(
  v: { vendor: string | null; productType: string | null },
  promotions: { startDate: string; endDate: string; upliftPct: number; scope: string; scopeValue: string | null }[],
  today: string,
  horizon: number,
): number[] {
  const out = new Array(horizon).fill(1);
  for (const p of promotions) {
    if (p.scope === "VENDOR" && p.scopeValue !== v.vendor) continue;
    if (p.scope === "PRODUCT_TYPE" && p.scopeValue !== v.productType) continue;
    const from = Math.max(0, diffDays(p.startDate, today));
    const to = Math.min(horizon - 1, diffDays(p.endDate, today));
    for (let i = from; i <= to; i++) out[i] *= 1 + p.upliftPct / 100;
  }
  return out;
}

function sumArr(a?: number[]) {
  return a ? a.reduce((s, x) => s + x, 0) : 0;
}

function chunked<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
