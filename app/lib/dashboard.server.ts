// Data for the one-screen admin dashboard.

import db from "../db.server";
import { addDays, diffDays, shortDate, todayIn } from "./dates";
import { variantLabel } from "./format";
import { leadTimeStats } from "./suppliers.server";

export async function dashboardData(shop: string, locationId: string) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const today = todayIn(shopRow.timezone);
  const forecasts = await db.forecast.findMany({ where: { shop, locationId } });
  const variants = new Map(
    (await db.variant.findMany({ where: { id: { in: forecasts.map((f) => f.variantId) } } })).map((v) => [v.id, v]),
  );
  const label = (id: string) => {
    const v = variants.get(id);
    return v ? variantLabel(v) : id;
  };

  const reorder = forecasts.filter((f) => f.status === "REORDER_NOW");
  const critical = reorder.filter((f) => f.daysOfCover < f.leadTimeDays);
  const overstock = forecasts.filter((f) => f.status === "OVERSTOCKED");
  const drafts = await db.purchaseOrder.findMany({
    where: { shop, status: "DRAFT" },
    include: { lines: true, supplier: true },
    orderBy: { createdAt: "desc" },
  });

  const snapshots = await db.accuracySnapshot.findMany({ where: { shop }, orderBy: { date: "desc" }, take: 40 });
  const accuracy = snapshots[0]?.accuracy ?? null;
  const monthAgo = snapshots.find((s) => diffDays(snapshots[0].date, s.date) >= 28);
  const accuracyDelta = accuracy !== null && monthAgo ? accuracy - monthAgo.accuracy : null;

  const protectedAlerts = await db.alert.aggregate({
    where: { shop, status: "RESOLVED", poId: { not: null }, resolvedAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
    _sum: { revenueAtRisk: true },
  });

  // Units sold per week for the last 12 weeks, then 4 forecast weeks.
  const weeksBack = 12;
  // The last bar includes today so new orders show up straight away.
  const start = addDays(today, -weeksBack * 7 + 1);
  const sales = await db.salesDaily.groupBy({
    by: ["date"],
    where: { shop, date: { gte: start, lte: today }, ...(locationId ? { locationId } : {}) },
    _sum: { units: true },
  });
  const weekly = new Array(weeksBack).fill(0);
  for (const s of sales) {
    const w = Math.floor(diffDays(s.date, start) / 7);
    if (w >= 0 && w < weeksBack) weekly[w] += s._sum.units ?? 0;
  }
  const forecastWeeks = [0, 0, 0, 0];
  for (const f of forecasts) {
    const series: number[] = JSON.parse(f.series);
    for (let w = 0; w < 4; w++) {
      for (let d = 0; d < 7; d++) forecastWeeks[w] += series[w * 7 + d] ?? 0;
    }
  }
  const chart = [
    ...weekly.map((u, i) => ({
      label: `W${i + 1}`,
      value: Math.round(u),
      forecast: false,
      from: shortDate(addDays(start, i * 7)),
      to: shortDate(addDays(start, i * 7 + 6)),
    })),
    ...forecastWeeks.map((u, i) => ({
      label: `W${weeksBack + i + 1}`,
      value: Math.round(u),
      forecast: true,
      from: shortDate(addDays(today, i * 7 + 1)),
      to: shortDate(addDays(today, i * 7 + 7)),
    })),
  ];

  const selling = forecasts.filter((f) => f.meanDaily > 0 && f.status !== "NO_DATA");
  const runningLow = [...selling]
    .sort((a, b) => a.daysOfCover - b.daysOfCover)
    .slice(0, 5)
    .map((f) => ({ variantId: f.variantId, sku: variants.get(f.variantId)?.sku ?? label(f.variantId), cover: f.daysOfCover, leadTime: f.leadTimeDays }));

  const rank = (f: (typeof forecasts)[number]) =>
    f.status === "REORDER_NOW" ? 3e9 + f.revenueAtRisk : f.status === "WATCH" ? 2e9 + f.revenueAtRisk : f.status === "OVERSTOCKED" ? 1e9 + f.overstockValue : f.revenueAtRisk;
  const attention = [...forecasts]
    .filter((f) => f.status !== "NO_DATA")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 8)
    .map((f) => ({
      variantId: f.variantId,
      label: label(f.variantId),
      sku: variants.get(f.variantId)?.sku ?? null,
      onHand: f.onHand,
      cover: f.daysOfCover,
      status: f.status,
      revenueAtRisk: f.revenueAtRisk,
    }));

  const topDraft = [...drafts].sort((a, b) => total(b.lines) - total(a.lines))[0];
  const draftVariants = topDraft
    ? new Map((await db.variant.findMany({ where: { id: { in: topDraft.lines.map((l) => l.variantId) } } })).map((v) => [v.id, v]))
    : new Map();
  const suggested = topDraft
    ? {
        id: topDraft.id,
        number: topDraft.number,
        supplier: topDraft.supplier.name,
        lines: topDraft.lines
          .slice()
          .sort((a, b) => b.quantity - a.quantity)
          .slice(0, 5)
          .map((l) => ({ label: draftVariants.get(l.variantId) ? variantLabel(draftVariants.get(l.variantId)) : l.variantId, quantity: l.quantity })),
        moreLines: Math.max(0, topDraft.lines.length - 5),
        total: total(topDraft.lines),
      }
    : null;

  const stats = await leadTimeStats(shop);
  const suppliersWithItems = new Set([...variants.values()].map((v) => v.supplierId).filter(Boolean));
  const leadTimes = [...stats.values()]
    .filter((s) => suppliersWithItems.has(s.supplierId))
    .sort((a, b) => b.effective - a.effective)
    .slice(0, 6)
    .map((s) => ({
      id: s.supplierId,
      name: s.name,
      days: s.effective,
      drift: s.latest !== null && s.previous !== null ? s.latest - s.previous : 0,
    }));

  return {
    kpis: {
      skusTracked: forecasts.length,
      skusAtRisk: reorder.length,
      critical: critical.length,
      needReorder: reorder.length,
      draftsReady: drafts.length,
      cashInOverstock: overstock.reduce((s, f) => s + f.overstockValue, 0),
      overstockSkus: overstock.length,
      accuracy,
      accuracyDelta,
      revenueProtected: protectedAlerts._sum.revenueAtRisk ?? 0,
    },
    chart,
    runningLow,
    attention,
    suggested,
    leadTimes,
  };
}

function total(lines: { quantity: number; unitCost: number }[]) {
  return lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
}
