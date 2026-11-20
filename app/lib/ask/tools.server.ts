// Tools Claude can call to answer questions about the merchant's inventory.
// Every tool reads from the shop's own catalog, orders, forecasts and supplier
// records, so answers are grounded and every figure is traceable.

import type Anthropic from "@anthropic-ai/sdk";
import db from "../../db.server";
import { addDays, diffDays, todayIn } from "../dates";
import { coverLabel, variantLabel } from "../format";
import { hasFeature } from "../plans";
import { createDraftPo } from "../po.server";
import { leadTimeStats } from "../suppliers.server";
import { stockCurve } from "../curve.server";

export const ASK_TOOLS: Anthropic.Tool[] = [
  {
    name: "inventory_summary",
    description:
      "Store-wide inventory health: SKUs tracked, how many need reordering, cash tied up in overstock, forecast accuracy, open alerts and draft purchase orders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_variants",
    description:
      "Find variants by product name, variant name, SKU or vendor. Returns stock, daily sales rate, days of cover, projected stockout date, reorder point, suggested order and status for each match.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match against title, SKU or vendor" },
        limit: { type: "integer", description: "Max results, default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "variants_running_out",
    description:
      "Variants projected to fall below safety stock or sell out before a given date at current forecast rates, ranked by revenue at risk. Use for questions like 'what will run dry before Black Friday'.",
    input_schema: {
      type: "object",
      properties: {
        before_date: { type: "string", description: "YYYY-MM-DD. Defaults to 30 days from today." },
        limit: { type: "integer", description: "Max results, default 15" },
      },
    },
  },
  {
    name: "variant_detail",
    description:
      "Full forecast for one variant: next 8 weeks of forecast demand with confidence band, last 8 weeks of actual sales, stock per location, open purchase orders, supplier and lead time, and whether an order placed today arrives before it sells out.",
    input_schema: {
      type: "object",
      properties: { variant_id: { type: "string", description: "Variant gid from search results" } },
      required: ["variant_id"],
    },
  },
  {
    name: "overstock",
    description: "Variants holding more stock than they will sell in the overstock window, ranked by cash tied up at cost.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "suppliers",
    description: "Suppliers with their rolling 90-day lead time, recent change, number of SKUs and open purchase orders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "show_chart",
    description:
      "Show a chart under your answer. Use it whenever numbers compare or change over time (days of cover per SKU, weekly sales, cash in overstock, supplier lead times). Every value must come from a tool result in this conversation. variant_detail already adds a stock curve, so do not redraw that.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar", "line"] },
        title: { type: "string" },
        unit: { type: "string", description: "Unit shown in tooltips, e.g. units, days, USD" },
        labels: { type: "array", items: { type: "string" }, description: "X axis labels, at most 24" },
        series: {
          type: "array",
          description: "One or two series, each with one value per label",
          items: {
            type: "object",
            properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } },
            required: ["name", "values"],
          },
        },
      },
      required: ["type", "labels", "series"],
    },
  },
  {
    name: "draft_purchase_order",
    description:
      "Create a DRAFT purchase order for one supplier. Nothing is sent: the merchant must review and approve it. Quantities default to the suggested order. Call only when the user asks to draft or create an order.",
    input_schema: {
      type: "object",
      properties: {
        supplier_id: { type: "string", description: "Supplier id. If omitted, the supplier of the first variant is used." },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              variant_id: { type: "string" },
              quantity: { type: "integer", description: "Units. Omit to use the suggested quantity." },
            },
            required: ["variant_id"],
          },
        },
        notes: { type: "string" },
      },
      required: ["lines"],
    },
  },
];

/** Charts attached to an answer: generic series charts, or a stock curve. */
export type AskChart =
  | { kind: "series"; spec: { type: "bar" | "line"; title?: string; unit?: string; labels: string[]; series: { name: string; values: number[] }[] } }
  | {
      kind: "stock";
      title: string;
      past: number[];
      now: number;
      future: number[];
      reorderPoint: number;
      crossingDay: number | null;
      leadTimeDay: number;
      today: string;
    };

export interface ToolContext {
  shop: string;
  createdPoIds: string[];
  charts?: AskChart[];
}

export async function runTool(name: string, input: any, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case "inventory_summary":
      return inventorySummary(ctx.shop);
    case "search_variants":
      return searchVariants(ctx.shop, String(input.query ?? ""), Number(input.limit ?? 10));
    case "variants_running_out":
      return runningOut(ctx.shop, input.before_date, Number(input.limit ?? 15));
    case "variant_detail":
      return variantDetail(ctx.shop, String(input.variant_id), ctx);
    case "overstock":
      return overstock(ctx.shop, Number(input.limit ?? 15));
    case "suppliers":
      return suppliers(ctx.shop);
    case "draft_purchase_order":
      return draftPo(ctx, input);
    case "show_chart":
      return showChart(ctx, input);
    default:
      return { error: `Unknown tool ${name}` };
  }
}

async function shopInfo(shop: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  return { s, today: todayIn(s.timezone) };
}

function row(f: any, v: any, today: string) {
  return {
    variant_id: f.variantId,
    name: v ? variantLabel(v) : f.variantId,
    sku: v?.sku ?? null,
    vendor: v?.vendor ?? null,
    units_on_hand: f.onHand,
    units_on_order: f.onOrder,
    daily_rate_14d: f.dailyRate14,
    forecast_daily_next_30d: f.meanDaily,
    days_of_cover: Math.round(f.daysOfCover * 10) / 10,
    projected_stockout: f.stockoutDate,
    reorder_point: Math.round(f.reorderPoint),
    safety_stock: Math.round(f.safetyStock),
    lead_time_days: f.leadTimeDays,
    order_today_arrives: addDays(today, Math.ceil(f.leadTimeDays)),
    suggested_order_qty: f.suggestedQty,
    revenue_at_risk: f.revenueAtRisk,
    status: f.status,
    forecast_confidence: f.confidence,
    price: v?.price ?? null,
    unit_cost: v?.unitCost ?? null,
    supplier_id: v?.supplierId ?? null,
  };
}

async function inventorySummary(shop: string) {
  const { s } = await shopInfo(shop);
  const f = await db.forecast.findMany({ where: { shop, locationId: "" } });
  const acc = await db.accuracySnapshot.findFirst({ where: { shop }, orderBy: { date: "desc" } });
  const [alerts, drafts] = await Promise.all([
    db.alert.count({ where: { shop, status: "OPEN" } }),
    db.purchaseOrder.count({ where: { shop, status: "DRAFT" } }),
  ]);
  return {
    currency: s.currency,
    skus_tracked: f.length,
    reorder_now: f.filter((x) => x.status === "REORDER_NOW").length,
    watch: f.filter((x) => x.status === "WATCH").length,
    overstocked: f.filter((x) => x.status === "OVERSTOCKED").length,
    cash_in_overstock_at_cost: Math.round(f.reduce((a, x) => a + x.overstockValue, 0)),
    revenue_at_risk: Math.round(f.reduce((a, x) => a + x.revenueAtRisk, 0)),
    forecast_accuracy: acc ? Math.round(acc.accuracy * 1000) / 10 : null,
    open_alerts: alerts,
    draft_purchase_orders: drafts,
    forecasts_built_at: s.lastForecastAt,
  };
}

async function searchVariants(shop: string, query: string, limit: number) {
  const { today } = await shopInfo(shop);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const variants = await db.variant.findMany({ where: { shop } });
  const matches = variants
    .filter((v) => {
      const hay = `${v.productTitle} ${v.variantTitle ?? ""} ${v.sku ?? ""} ${v.vendor ?? ""} ${v.productType ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 200);
  const f = await db.forecast.findMany({ where: { shop, locationId: "", variantId: { in: matches.map((m) => m.id) } } });
  const byId = new Map(matches.map((m) => [m.id, m]));
  return f
    .sort((a, b) => b.revenueAtRisk - a.revenueAtRisk || a.daysOfCover - b.daysOfCover)
    .slice(0, Math.min(limit, 30))
    .map((x) => row(x, byId.get(x.variantId), today));
}

async function runningOut(shop: string, beforeDate: string | undefined, limit: number) {
  const { today } = await shopInfo(shop);
  const before = beforeDate && /^\d{4}-\d{2}-\d{2}$/.test(beforeDate) ? beforeDate : addDays(today, 30);
  const horizon = diffDays(before, today);
  const f = await db.forecast.findMany({ where: { shop, locationId: "", meanDaily: { gt: 0 } } });
  const out = [];
  for (const x of f) {
    const series: number[] = JSON.parse(x.series);
    // Day the projected stock (with incoming POs approximated as on order) drops below safety stock.
    let stock = x.onHand;
    let belowSafety: number | null = null;
    for (let d = 0; d < Math.min(horizon, series.length); d++) {
      stock -= series[d];
      if (stock < x.safetyStock && belowSafety === null) belowSafety = d;
    }
    const outBefore = x.stockoutDate !== null && x.stockoutDate <= before;
    if (outBefore || belowSafety !== null) out.push({ x, belowSafety });
  }
  const variants = new Map(
    (await db.variant.findMany({ where: { id: { in: out.map((o) => o.x.variantId) } } })).map((v) => [v.id, v]),
  );
  return {
    today,
    before,
    count: out.length,
    variants: out
      .sort((a, b) => b.x.revenueAtRisk - a.x.revenueAtRisk || a.x.daysOfCover - b.x.daysOfCover)
      .slice(0, Math.min(limit, 40))
      .map((o) => ({
        ...row(o.x, variants.get(o.x.variantId), today),
        falls_below_safety_stock_on: o.belowSafety !== null ? addDays(today, o.belowSafety) : null,
        can_be_covered_by_normal_order: o.x.daysOfCover >= o.x.leadTimeDays,
      })),
  };
}

function showChart(ctx: ToolContext, input: any) {
  const labels: string[] = (input.labels ?? []).map(String).slice(0, 24);
  const series = (input.series ?? [])
    .slice(0, 2)
    .map((s: any) => ({ name: String(s.name ?? "Value"), values: (s.values ?? []).map(Number).slice(0, labels.length) }))
    .filter((s: { values: number[] }) => s.values.length === labels.length && s.values.every(Number.isFinite));
  if (!labels.length || !series.length) return { error: "Each series needs one numeric value per label." };
  ctx.charts = ctx.charts ?? [];
  if (ctx.charts.length >= 3) return { error: "At most three charts per answer." };
  ctx.charts.push({ kind: "series", spec: { type: input.type === "line" ? "line" : "bar", title: input.title, unit: input.unit, labels, series } });
  return { shown: true };
}

async function variantDetail(shop: string, variantId: string, ctx?: ToolContext) {
  const { today } = await shopInfo(shop);
  const v = await db.variant.findFirst({ where: { shop, id: variantId }, include: { supplier: true } });
  if (!v) return { error: "Variant not found" };
  const f = await db.forecast.findMany({ where: { shop, variantId } });
  const all = f.find((x) => x.locationId === "");
  const locations = new Map((await db.location.findMany({ where: { shop } })).map((l) => [l.id, l.name]));
  const levels = await db.inventoryLevel.findMany({ where: { shop, variantId } });
  const sales = await db.salesDaily.groupBy({
    by: ["date"],
    where: { variantId, date: { gte: addDays(today, -56), lt: today } },
    _sum: { units: true },
  });
  const weeklyActual = new Array(8).fill(0);
  for (const s of sales) {
    const w = Math.floor(diffDays(s.date, addDays(today, -56)) / 7);
    if (w >= 0 && w < 8) weeklyActual[w] += s._sum.units ?? 0;
  }
  const series: number[] = all ? JSON.parse(all.series) : [];
  const lower: number[] = all ? JSON.parse(all.lower) : [];
  const upper: number[] = all ? JSON.parse(all.upper) : [];
  const weekly = (arr: number[]) => Array.from({ length: 8 }, (_, w) => Math.round(arr.slice(w * 7, w * 7 + 7).reduce((a, b) => a + b, 0)));
  const openPos = await db.purchaseOrderLine.findMany({
    where: { variantId, po: { shop, status: { in: ["DRAFT", "APPROVED", "SENT", "PARTIAL"] } } },
    include: { po: true },
  });
  // Attach the stock curve so the answer shows where this SKU is heading.
  if (ctx && all) {
    const curve = await stockCurve(shop, variantId, { pastDays: 21 });
    if (curve) {
      ctx.charts = ctx.charts ?? [];
      if (ctx.charts.length < 3 && !ctx.charts.some((c) => c.kind === "stock" && c.title.startsWith(variantLabel(v)))) {
        ctx.charts.push({
          kind: "stock",
          title: `${variantLabel(v)}: projected units on hand`,
          past: curve.past,
          now: curve.onHand,
          future: curve.future,
          reorderPoint: curve.reorderPoint,
          crossingDay: curve.crossingDay,
          leadTimeDay: curve.leadTimeDay,
          today: curve.today,
        });
      }
    }
  }
  return {
    ...(all ? row(all, v, today) : { name: variantLabel(v), sku: v.sku, status: "NO_FORECAST" }),
    supplier: v.supplier ? { id: v.supplier.id, name: v.supplier.name } : null,
    weekly_actual_last_8_weeks: weeklyActual,
    weekly_forecast_next_8_weeks: weekly(series),
    weekly_forecast_low_80: weekly(lower),
    weekly_forecast_high_80: weekly(upper),
    stock_by_location: levels.map((l) => ({ location: locations.get(l.locationId) ?? l.locationId, available: l.available, incoming: l.incoming })),
    location_forecasts: f
      .filter((x) => x.locationId)
      .map((x) => ({ location: locations.get(x.locationId), days_of_cover: x.daysOfCover, status: x.status })),
    open_purchase_orders: openPos.map((l) => ({
      number: l.po.number,
      status: l.po.status,
      quantity: l.quantity,
      received: l.receivedQty,
      expected: l.po.expectedAt?.toISOString().slice(0, 10) ?? null,
    })),
  };
}

async function overstock(shop: string, limit: number) {
  const { s, today } = await shopInfo(shop);
  const f = await db.forecast.findMany({
    where: { shop, locationId: "", status: "OVERSTOCKED" },
    orderBy: { overstockValue: "desc" },
    take: Math.min(limit, 40),
  });
  const variants = new Map((await db.variant.findMany({ where: { id: { in: f.map((x) => x.variantId) } } })).map((v) => [v.id, v]));
  return {
    overstock_window_days: s.overstockDays,
    variants: f.map((x) => ({ ...row(x, variants.get(x.variantId), today), excess_units: Math.round(x.overstockUnits), cash_tied_up: Math.round(x.overstockValue), cover: coverLabel(x.daysOfCover) })),
  };
}

async function suppliers(shop: string) {
  const stats = await leadTimeStats(shop);
  const counts = await db.variant.groupBy({ by: ["supplierId"], where: { shop }, _count: true });
  const open = await db.purchaseOrder.groupBy({
    by: ["supplierId"],
    where: { shop, status: { in: ["APPROVED", "SENT", "PARTIAL"] } },
    _count: true,
  });
  return [...stats.values()].map((s) => ({
    supplier_id: s.supplierId,
    name: s.name,
    lead_time_days_90d_avg: Math.round(s.effective * 10) / 10,
    latest_observed: s.latest,
    previous_average: s.previous,
    skus: counts.find((c) => c.supplierId === s.supplierId)?._count ?? 0,
    open_purchase_orders: open.find((c) => c.supplierId === s.supplierId)?._count ?? 0,
  }));
}

async function draftPo(ctx: ToolContext, input: any) {
  const { s } = await shopInfo(ctx.shop);
  if (!hasFeature(s.plan, "draftPurchaseOrders")) return { error: "Draft purchase orders need the Scale or Pro plan." };
  const lines: { variant_id: string; quantity?: number }[] = input.lines ?? [];
  if (!lines.length) return { error: "No lines given" };
  const variants = await db.variant.findMany({ where: { shop: ctx.shop, id: { in: lines.map((l) => l.variant_id) } } });
  if (!variants.length) return { error: "None of those variants were found" };
  const supplierId = input.supplier_id ?? variants[0].supplierId;
  if (!supplierId) return { error: "This variant has no supplier. Ask the merchant to assign one on the Suppliers page." };
  const forecasts = new Map(
    (await db.forecast.findMany({ where: { shop: ctx.shop, locationId: "", variantId: { in: variants.map((v) => v.id) } } })).map((f) => [f.variantId, f]),
  );
  const po = await createDraftPo(ctx.shop, {
    supplierId,
    source: "ASK",
    notes: input.notes,
    lines: lines.map((l) => ({ variantId: l.variant_id, quantity: l.quantity ?? forecasts.get(l.variant_id)?.suggestedQty ?? 0 })),
  });
  ctx.createdPoIds.push(po.id);
  return {
    created: true,
    status: "DRAFT, waiting for approval",
    number: po.number,
    supplier: po.supplier.name,
    expected: po.expectedAt?.toISOString().slice(0, 10),
    lines: po.lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity, unit_cost: l.unitCost })),
    total: Math.round(po.lines.reduce((a, l) => a + l.quantity * l.unitCost, 0) * 100) / 100,
  };
}
