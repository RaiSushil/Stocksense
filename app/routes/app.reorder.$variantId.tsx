import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { addDays, shortDate, todayIn } from "../lib/dates";
import { money, num, variantLabel } from "../lib/format";
import { hasFeature } from "../lib/plans";
import { createDraftPo, OPEN_STATUSES } from "../lib/po.server";
import { leadTimeStats } from "../lib/suppliers.server";
import { keyList, setPreferredForCategories } from "../lib/supplier-form.server";
import { incomingFor } from "../lib/forecast/run.server";
import { orderBreakdown, projectStock, type IncomingStock } from "../lib/forecast/inventory";
import { inBackground, runPartialRefresh, runRebuild } from "../lib/jobs.server";
import { SeriesChart } from "../components/charts";
import { Badge, Banner, Btn, Card, Check, Kpi, KpiStrip, Page, StatusBadge } from "../components/ui";

const gidOf = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const variantId = gidOf(params.variantId!);
  const variant = await db.variant.findFirst({ where: { shop: shop.id, id: variantId }, include: { supplier: true } });
  if (!variant) throw new Response("Not found", { status: 404 });
  const today = todayIn(shop.timezone);
  const f = await db.forecast.findUnique({ where: { variantId_locationId: { variantId, locationId: "" } } });

  // Stock already on its way, landing on each purchase order's expected day.
  const openLines = await db.purchaseOrderLine.findMany({
    where: { variantId, po: { shop: shop.id, status: { in: OPEN_STATUSES } } },
    include: { po: true },
  });
  const stats = await leadTimeStats(shop.id);
  const currentLead = variant.leadTimeOverride ?? (variant.supplierId ? stats.get(variant.supplierId)?.effective : undefined) ?? shop.defaultLeadTimeDays;
  const incoming = incomingFor(
    openLines.filter((l) => l.po.status !== "DRAFT"),
    today,
    currentLead,
  );

  const suppliers = await db.supplier.findMany({ where: { shop: shop.id }, orderBy: { name: "asc" } });
  const categorySkus = variant.productType ? await db.variant.count({ where: { shop: shop.id, productType: variant.productType } }) : 0;

  // Other products that need ordering, so one purchase order can cover a supplier's whole list.
  const onOpenPo = new Set(
    (
      await db.purchaseOrderLine.findMany({
        where: { po: { shop: shop.id, status: { in: OPEN_STATUSES }, NOT: { status: "DRAFT", source: "AUTO" } } },
        select: { variantId: true },
      })
    ).map((l) => l.variantId),
  );
  const needs = await db.forecast.findMany({
    where: { shop: shop.id, locationId: "", status: { in: ["REORDER_NOW", "WATCH"] }, suggestedQty: { gt: 0 }, NOT: { variantId } },
    orderBy: { daysOfCover: "asc" },
    take: 200,
  });
  const needVariants = new Map(
    (await db.variant.findMany({ where: { id: { in: needs.map((n) => n.variantId) } } })).map((v) => [v.id, v]),
  );
  const others = needs
    .filter((n) => !onOpenPo.has(n.variantId) && needVariants.get(n.variantId)?.supplierId)
    .map((n) => {
      const v = needVariants.get(n.variantId)!;
      return {
        variantId: n.variantId,
        label: variantLabel(v),
        sku: v.sku,
        supplierId: v.supplierId!,
        suggested: n.suggestedQty,
        status: n.status,
        cover: n.daysOfCover,
        unitCost: v.unitCost ?? 0,
      };
    });

  const drafts = await db.purchaseOrder.findMany({
    where: { shop: shop.id, status: "DRAFT" },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });

  const mean: number[] = f ? (JSON.parse(f.series) as number[]) : [];
  return {
    today,
    currency: shop.currency,
    canDraft: hasFeature(shop.plan, "draftPurchaseOrders"),
    serviceLevel: shop.serviceLevel,
    coverageDays: shop.coverageDays,
    defaultLead: shop.defaultLeadTimeDays,
    variant: {
      id: variant.id,
      label: variantLabel(variant),
      sku: variant.sku,
      vendor: variant.vendor,
      category: variant.productType,
      categorySkus,
      unitCost: variant.unitCost ?? 0,
      price: variant.price,
      supplierId: variant.supplierId,
      casePack: variant.casePack,
      minOrderQty: variant.minOrderQty,
      leadTimeOverride: variant.leadTimeOverride,
    },
    forecast: f
      ? {
          mean: mean.slice(0, 365),
          sigmaDaily: f.sigmaDaily,
          onHand: f.onHand,
          onOrder: f.onOrder,
          status: f.status,
          daysOfCover: f.daysOfCover,
          stockoutDate: f.stockoutDate,
          suggestedQty: f.suggestedQty,
          meanDaily: f.meanDaily,
          confidence: f.confidence,
          method: f.method,
        }
      : null,
    incoming,
    suppliers: suppliers.map((s) => {
      const st = stats.get(s.id);
      return {
        id: s.id,
        name: s.name,
        lead: st?.effective ?? s.defaultLeadTimeDays,
        leadStd: st?.std ?? s.defaultLeadTimeDays * 0.2,
        observations: st?.observations ?? 0,
        minOrderValue: s.minOrderValue,
        email: s.email,
        categories: keyList(s.categoryKey),
        vendors: keyList(s.vendorKey),
      };
    }),
    openPos: openLines.map((l) => ({ id: l.po.id, number: l.po.number, status: l.po.status, qty: Math.max(0, l.quantity - l.receivedQty) })),
    drafts: drafts.map((d) => ({ id: d.id, number: d.number, supplierId: d.supplierId, lines: d.lines.length, source: d.source })),
    others,
  };
};

const int = (v: FormDataEntryValue | null, fallback: number) => {
  const s = String(v ?? "").trim();
  if (s === "") return fallback;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? n : fallback;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const variantId = gidOf(params.variantId!);
  const variant = await db.variant.findFirstOrThrow({ where: { shop: shop.id, id: variantId } });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const supplierId = String(form.get("supplierId") ?? "");
  const supplier = supplierId ? await db.supplier.findFirst({ where: { id: supplierId, shop: shop.id } }) : null;
  if (!supplier) return { error: "Choose a supplier." };

  const leadRaw = String(form.get("leadTimeOverride") ?? "").trim();
  const leadTimeOverride = leadRaw === "" ? null : Math.min(365, Math.max(1, int(leadRaw, 1)));
  const casePack = Math.max(1, int(form.get("casePack"), 1));
  const minOrderQty = Math.max(0, int(form.get("minOrderQty"), 0));
  const remember = form.get("remember") === "on";
  const forCategory = form.get("forCategory") === "on" && !!variant.productType;

  // Settings first, so the new purchase order and the refreshed forecast agree.
  if (remember) {
    await db.variant.update({ where: { id: variant.id }, data: { supplierId: supplier.id, casePack, minOrderQty, leadTimeOverride } });
  }
  if (forCategory) await setPreferredForCategories(shop.id, supplier.id, [variant.productType!]);

  if (intent === "save") {
    if (forCategory) inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
    else inBackground("refresh", runPartialRefresh(shop.id, [variant.id]));
    const parts = [remember ? `${supplier.name} is now the preferred supplier for this product` : null, forCategory ? `and for every ${variant.productType} product` : null];
    return { ok: `${parts.filter(Boolean).join(" ") || "Nothing to save"}. Forecasts are recalculating.` };
  }

  if (intent !== "create") return { error: "Unknown action" };
  if (!hasFeature(shop.plan, "draftPurchaseOrders")) return { error: "Draft purchase orders need the Scale or Pro plan." };

  const qty = int(form.get("quantity"), 0);
  if (qty < 1) return { error: "Enter a quantity of at least 1." };
  const unitCostRaw = String(form.get("unitCost") ?? "").trim();
  const unitCost = unitCostRaw === "" ? (variant.unitCost ?? 0) : Math.max(0, Number(unitCostRaw) || 0);

  const lines = [{ variantId: variant.id, quantity: qty, unitCost }];
  for (const id of form.getAll("extra").map(String)) {
    const q = int(form.get(`qty:${id}`), 0);
    if (q > 0 && id !== variant.id) lines.push({ variantId: id, quantity: q, unitCost: NaN });
  }
  // Extra lines use each product's own cost.
  const costs = new Map(
    (await db.variant.findMany({ where: { shop: shop.id, id: { in: lines.map((l) => l.variantId) } }, select: { id: true, unitCost: true } })).map((v) => [v.id, v.unitCost ?? 0]),
  );
  const clean = lines
    .filter((l) => costs.has(l.variantId))
    .map((l) => ({ ...l, unitCost: Number.isNaN(l.unitCost) ? costs.get(l.variantId)! : l.unitCost }));

  const note = String(form.get("notes") ?? "").trim() || undefined;
  const target = String(form.get("target") ?? "new");
  let poId: string;
  if (target !== "new") {
    const draft = await db.purchaseOrder.findFirst({ where: { id: target, shop: shop.id, status: "DRAFT", supplierId: supplier.id }, include: { lines: true } });
    if (!draft) return { error: "That draft purchase order is no longer open for this supplier. Choose another." };
    await db.$transaction([
      ...clean.map((l) => {
        const line = draft.lines.find((x) => x.variantId === l.variantId);
        return line
          ? db.purchaseOrderLine.update({ where: { id: line.id }, data: { quantity: l.quantity, unitCost: l.unitCost } })
          : db.purchaseOrderLine.create({ data: { poId: draft.id, ...l } });
      }),
      // A draft someone has edited is no longer managed automatically.
      db.purchaseOrder.update({ where: { id: draft.id }, data: { source: "MANUAL", notes: note ?? draft.notes } }),
    ]);
    poId = draft.id;
  } else {
    const po = await createDraftPo(shop.id, { supplierId: supplier.id, source: "MANUAL", lines: clean, notes: note });
    // Plan the delivery on the lead time used for this order.
    if (leadTimeOverride) await db.purchaseOrder.update({ where: { id: po.id }, data: { expectedAt: new Date(Date.now() + leadTimeOverride * 86_400_000) } });
    poId = po.id;
  }
  inBackground(forCategory ? "rebuild" : "refresh", forCategory ? runRebuild(shop.id, { refreshCatalog: false }) : runPartialRefresh(shop.id, clean.map((l) => l.variantId)));
  throw redirect(`/app/purchase-orders/${poId}?created=1`);
};

export default function Reorder() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const v = d.variant;
  const f = d.forecast;
  const fmt = (n: number) => money(n, d.currency);

  const initialSupplier =
    v.supplierId ?? d.suppliers.find((s) => v.category && s.categories.includes(v.category))?.id ?? d.suppliers.find((s) => v.vendor && s.vendors.includes(v.vendor))?.id ?? d.suppliers[0]?.id ?? "";
  const [supplierId, setSupplierId] = useState(initialSupplier);
  const [leadOverride, setLeadOverride] = useState(v.leadTimeOverride ? String(v.leadTimeOverride) : "");
  const [casePack, setCasePack] = useState(String(v.casePack));
  const [moq, setMoq] = useState(String(v.minOrderQty));
  const [coverage, setCoverage] = useState(String(d.coverageDays));
  const [qty, setQty] = useState<string | null>(null);
  const [unitCost, setUnitCost] = useState(String(v.unitCost));
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("new");

  const supplier = d.suppliers.find((s) => s.id === supplierId) ?? null;
  const n = (s: string, fb: number) => (s.trim() === "" || !Number.isFinite(Number(s)) ? fb : Number(s));
  const lead = leadOverride ? Math.max(1, n(leadOverride, 1)) : (supplier?.lead ?? d.defaultLead);
  const leadStd = leadOverride ? lead * 0.15 : (supplier?.leadStd ?? lead * 0.2);
  const mean = f?.mean.length ? f.mean : [0];

  const breakdownFor = (leadDays: number, std: number) =>
    orderBreakdown({
      mean,
      sigmaDaily: f?.sigmaDaily ?? 0,
      onHand: f?.onHand ?? 0,
      onOrder: f?.onOrder ?? 0,
      leadTimeDays: leadDays,
      leadTimeStdDays: std,
      serviceLevel: d.serviceLevel,
      coverageDays: Math.max(0, n(coverage, d.coverageDays)),
      casePack: Math.max(1, Math.round(n(casePack, 1))),
      minOrderQty: Math.max(0, Math.round(n(moq, 0))),
    });
  const b = breakdownFor(lead, leadStd);
  const quantity = qty === null ? b.suggested : Math.max(0, Math.round(n(qty, 0)));
  const arrival = addDays(d.today, b.leadTimeDays);

  const days = Math.min(150, b.leadTimeDays + Math.max(14, Math.round(n(coverage, d.coverageDays))) + 14);
  const incoming = d.incoming as IncomingStock[];
  const without = projectStock(mean, f?.onHand ?? 0, incoming, days);
  const withOrder = projectStock(mean, f?.onHand ?? 0, [...incoming, { day: b.leadTimeDays, qty: quantity }], days);
  // Days with no stock before the order lands, then how long the order lasts once it is in.
  const gapStart = without.stockoutDay !== null && without.stockoutDay < b.leadTimeDays ? Math.floor(without.stockoutDay) : null;
  const afterArrival = withOrder.projection.findIndex((x, i) => i >= b.leadTimeDays && x <= 0.5);
  const coveredUntil = afterArrival >= 0 ? addDays(d.today, afterArrival) : null;
  const fastest = [...d.suppliers].sort((x, y) => x.lead - y.lead)[0];

  const others = d.others.filter((o) => o.supplierId === supplierId);
  const extraLines = others.filter((o) => extra[o.variantId] !== undefined);
  const extraTotal = extraLines.reduce((s, o) => s + Math.max(0, n(extra[o.variantId], 0)) * o.unitCost, 0);
  const lineTotal = quantity * Math.max(0, n(unitCost, 0));
  const total = lineTotal + extraTotal;
  const drafts = d.drafts.filter((x) => x.supplierId === supplierId);
  const targetValue = drafts.some((x) => x.id === target) ? target : "new";
  const categoryOwner = v.category ? d.suppliers.find((s) => s.categories.includes(v.category!)) : undefined;
  const noDemand = !f || b.avgDaily <= 0;
  const openNonDraft = d.openPos.filter((p) => p.status !== "DRAFT");
  const openDraft = d.openPos.filter((p) => p.status === "DRAFT");

  const labels = Array.from({ length: days }, (_, i) => shortDate(addDays(d.today, i)));
  const chart = {
    type: "line" as const,
    unit: "units",
    labels,
    series: [
      { name: "Without this order", values: without.projection.map((x) => Math.round(x)) },
      { name: "With this order", values: withOrder.projection.map((x) => Math.round(x)) },
      { name: "Safety stock", values: labels.map(() => Math.round(b.safetyStock)) },
    ],
  };

  return (
    <Page
      back={{ href: `/app/forecasts/${encodeURIComponent(v.id)}`, label: "Forecast" }}
      eyebrow="Reorder"
      title={v.label}
      subtitle={[v.sku ?? "No SKU", v.category, v.vendor].filter(Boolean).join(" · ")}
      actions={f ? <StatusBadge status={f.status} /> : undefined}
    >
      {result && "error" in result && <Banner tone="critical" title={result.error} />}
      {result && "ok" in result && <Banner tone="success" title={result.ok} />}

      <KpiStrip>
        <Kpi label="On hand" value={num(f?.onHand ?? 0)} note={f?.onOrder ? `+${num(f.onOrder)} on order` : undefined} tone="info" />
        <Kpi label="Forecast per day" value={num(b.avgDaily, 1)} note={f ? `${f.confidence.toLowerCase()} confidence` : "no forecast"} />
        <Kpi
          label="Runs out"
          value={without.stockoutDay === null ? "Not soon" : shortDate(addDays(d.today, Math.floor(without.stockoutDay)))}
          note={without.stockoutDay === null ? undefined : `${Math.floor(without.stockoutDay)} days`}
          tone={without.stockoutDay !== null && without.stockoutDay <= b.leadTimeDays ? "critical" : "warning"}
        />
        <Kpi label="Order arrives" value={shortDate(arrival)} note={`${b.leadTimeDays}-day lead time`} tone="neutral" />
        <Kpi label="Suggested" value={num(b.suggested)} note="units" tone="warning" />
      </KpiStrip>

      {openNonDraft.length > 0 && (
        <Banner tone="info" title={`Already ordered: ${openNonDraft.map((p) => `${p.number} (${num(p.qty)} units, ${p.status.toLowerCase()})`).join(", ")}`}>
          Those units are counted as on order, so the suggestion below only covers what is still missing.
        </Banner>
      )}
      {openDraft.length > 0 && (
        <Banner tone="warning" title={`This product is already on draft ${openDraft.map((p) => p.number).join(", ")}`}>
          Pick that draft under “Add to” to update its quantity instead of creating a second order.
        </Banner>
      )}

      <Form method="post">
        <div className="ss-split ss-reorder">
          <div className="ss-stack">
            <Card title="1. Supplier" subtitle="Lead time and suggested quantity for each supplier. Pick the one to order from.">
              {d.suppliers.length === 0 ? (
                <span className="ss-muted">
                  No suppliers yet. <Link to="/app/suppliers/new">Add a supplier</Link> first.
                </span>
              ) : (
                <div className="ss-choice-list" role="radiogroup" aria-label="Supplier">
                  {d.suppliers.map((s) => {
                    const sl = leadOverride ? lead : s.lead;
                    const sb = breakdownFor(sl, leadOverride ? leadStd : s.leadStd);
                    const tags = [
                      s.id === v.supplierId ? "current" : null,
                      v.category && s.categories.includes(v.category) ? `preferred for ${v.category}` : null,
                      v.vendor && s.vendors.includes(v.vendor) ? `makes ${v.vendor}` : null,
                    ].filter(Boolean) as string[];
                    return (
                      <label key={s.id} className={`ss-choice${s.id === supplierId ? " on" : ""}`} aria-label={s.name}>
                        <input type="radio" name="supplierId" value={s.id} checked={s.id === supplierId} onChange={() => setSupplierId(s.id)} />
                        <span className="ss-choice-main">
                          <b>{s.name}</b>
                          <small>
                            {tags.length ? tags.join(" · ") : s.email ?? "no email"}
                          </small>
                        </span>
                        <span className="ss-choice-num">
                          <b>{num(sl, sl % 1 ? 1 : 0)} days</b>
                          <small>{s.observations ? `from ${s.observations} deliveries` : "set lead time"}</small>
                        </span>
                        <span className="ss-choice-num">
                          <b>{shortDate(addDays(d.today, Math.max(1, Math.ceil(sl))))}</b>
                          <small>arrives</small>
                        </span>
                        <span className="ss-choice-num">
                          <b>{num(sb.suggested)}</b>
                          <small>suggested</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {supplier && (
                <div className="ss-remember">
                  <Check name="remember" defaultChecked label={`Save ${supplier.name} as the preferred supplier for this product, with the ordering rules below`} />
                  {v.category ? (
                    categoryOwner?.id === supplier.id ? (
                      <span className="ss-muted ss-small">
                        {supplier.name} is already the preferred supplier for every {v.category} product.
                      </span>
                    ) : (
                      <Check
                        name="forCategory"
                        label={`Make ${supplier.name} the preferred supplier for all ${v.category} products (${v.categorySkus} SKU${v.categorySkus === 1 ? "" : "s"})${categoryOwner ? `, replacing ${categoryOwner.name}` : ""}`}
                      />
                    )
                  ) : (
                    <span className="ss-muted ss-small">This product has no category in Shopify, so a category preference can&apos;t be saved for it.</span>
                  )}
                </div>
              )}
            </Card>

            <Card title="2. Quantity" subtitle="How the suggestion is worked out. Change any input and it recalculates.">
              {noDemand && (
                <Banner tone="info" title="No sales forecast for this product yet, so there is nothing to suggest. Enter the quantity you want." />
              )}
              <div className="ss-calc">
                <div className="ss-calc-row">
                  <span>Sold while the order is on its way</span>
                  <small>
                    {b.leadTimeDays} days × {num(b.leadTimeDemand / b.leadTimeDays, 1)}/day
                  </small>
                  <b>{num(b.leadTimeDemand)}</b>
                </div>
                <div className="ss-calc-row">
                  <span>Sold in the coverage window after it lands</span>
                  <small>{num(n(coverage, d.coverageDays))} days</small>
                  <b>+ {num(b.coverageDemand)}</b>
                </div>
                <div className="ss-calc-row">
                  <span>Safety stock</span>
                  <small>{Math.round(d.serviceLevel * 1000) / 10}% service level</small>
                  <b>+ {num(b.safetyStock)}</b>
                </div>
                <div className="ss-calc-row total">
                  <span>Stock to have</span>
                  <small />
                  <b>{num(b.target)}</b>
                </div>
                <div className="ss-calc-row">
                  <span>On hand and already on order</span>
                  <small>
                    {num(f?.onHand ?? 0)} + {num(f?.onOrder ?? 0)}
                  </small>
                  <b>− {num(b.position)}</b>
                </div>
                <div className="ss-calc-row">
                  <span>Short by</span>
                  <small />
                  <b>{num(b.shortfall)}</b>
                </div>
                {b.afterMinimum !== b.shortfall && (
                  <div className="ss-calc-row">
                    <span>Raised to the minimum order</span>
                    <small>min {num(n(moq, 0))}</small>
                    <b>{num(b.afterMinimum)}</b>
                  </div>
                )}
                {b.suggested !== b.afterMinimum && (
                  <div className="ss-calc-row">
                    <span>Rounded up to whole case packs</span>
                    <small>packs of {num(n(casePack, 1))}</small>
                    <b>{num(b.suggested)}</b>
                  </div>
                )}
                <div className="ss-calc-row result">
                  <span>Suggested order</span>
                  <small />
                  <b>{num(b.suggested)} units</b>
                </div>
              </div>

              <div className="ss-form-grid" style={{ ["--ss-min" as string]: "150px", marginTop: 18 }}>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-coverage">
                    Coverage (days)
                  </label>
                  <input id="ro-coverage" className="ss-input" type="number" min={0} max={365} value={coverage} onChange={(e) => setCoverage(e.target.value)} />
                  <span className="ss-help">This order only</span>
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-lead">
                    Lead time (days)
                  </label>
                  <input
                    id="ro-lead"
                    className="ss-input"
                    type="number"
                    min={1}
                    max={365}
                    name="leadTimeOverride"
                    value={leadOverride}
                    placeholder={supplier ? `${num(supplier.lead, supplier.lead % 1 ? 1 : 0)} (supplier)` : ""}
                    onChange={(e) => setLeadOverride(e.target.value)}
                  />
                  <span className="ss-help">Blank uses the supplier&apos;s</span>
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-pack">
                    Case pack
                  </label>
                  <input id="ro-pack" className="ss-input" type="number" min={1} name="casePack" value={casePack} onChange={(e) => setCasePack(e.target.value)} />
                  <span className="ss-help">Order in multiples of</span>
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-moq">
                    Minimum order qty
                  </label>
                  <input id="ro-moq" className="ss-input" type="number" min={0} name="minOrderQty" value={moq} onChange={(e) => setMoq(e.target.value)} />
                  <span className="ss-help">0 if none</span>
                </div>
              </div>
            </Card>

            <Card title="Stock with and without this order" subtitle={`Units on hand per day. The order lands on ${shortDate(arrival)}. Hover for exact numbers.`}>
              <SeriesChart spec={chart} height={240} />
              <div className="ss-stack" style={{ gap: 8 }}>
                {gapStart !== null && (
                  <Banner tone="warning" title={`You run out on ${shortDate(addDays(d.today, gapStart))}, ${b.leadTimeDays - gapStart} day${b.leadTimeDays - gapStart === 1 ? "" : "s"} before this order lands.`}>
                    {fastest && fastest.id !== supplierId && Math.ceil(fastest.lead) < b.leadTimeDays
                      ? `${fastest.name} is the fastest supplier (${num(fastest.lead, fastest.lead % 1 ? 1 : 0)} days, arriving ${shortDate(addDays(d.today, Math.ceil(fastest.lead)))}). Consider a small rush order there, or a transfer from another location.`
                      : "Consider a transfer from another location or asking the supplier to expedite."}
                  </Banner>
                )}
                <span className="ss-muted ss-small">
                  {coveredUntil
                    ? `Once it lands, ${num(quantity)} units cover you until ${shortDate(coveredUntil)}.`
                    : `Once it lands, ${num(quantity)} units cover you for the rest of the ${days}-day window.`}
                </span>
              </div>
            </Card>

            {supplier && others.length > 0 && (
              <Card title={`Also order from ${supplier.name}`} subtitle="Other products from this supplier that need stock. Tick to add them to the same purchase order." flush>
                <div className="ss-table-wrap">
                  <table className="ss-table">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }} />
                        <th>Product</th>
                        <th className="num">Cover</th>
                        <th>Status</th>
                        <th className="num">Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {others.map((o) => {
                        const on = extra[o.variantId] !== undefined;
                        return (
                          <tr key={o.variantId}>
                            <td>
                              <input
                                type="checkbox"
                                name="extra"
                                value={o.variantId}
                                checked={on}
                                aria-label={`Add ${o.label}`}
                                onChange={(e) =>
                                  setExtra((prev) => {
                                    const next = { ...prev };
                                    if (e.target.checked) next[o.variantId] = String(o.suggested);
                                    else delete next[o.variantId];
                                    return next;
                                  })
                                }
                              />
                            </td>
                            <td>
                              <div className="ss-item">
                                <span className="ss-strong">{o.label}</span>
                                <span className="ss-sku">{o.sku ?? "no SKU"}</span>
                              </div>
                            </td>
                            <td className="num ss-mono">{num(o.cover)} days</td>
                            <td>
                              <StatusBadge status={o.status} />
                            </td>
                            <td className="num">
                              <input
                                className="ss-input ss-qty"
                                type="number"
                                min={0}
                                name={`qty:${o.variantId}`}
                                disabled={!on}
                                value={on ? extra[o.variantId] : String(o.suggested)}
                                onChange={(e) => setExtra((prev) => ({ ...prev, [o.variantId]: e.target.value }))}
                                aria-label={`Quantity for ${o.label}`}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>

          <div className="ss-sticky">
            <Card title="Purchase order">
              <div className="ss-stack">
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-qty">
                    Order quantity
                  </label>
                  <div className="ss-qty-row">
                    <input id="ro-qty" className="ss-input ss-qty-big" type="number" min={0} name="quantity" value={quantity} onChange={(e) => setQty(e.target.value)} />
                    {qty !== null && Number(qty) !== b.suggested && (
                      <Btn small variant="ghost" onClick={() => setQty(null)}>
                        Use {num(b.suggested)}
                      </Btn>
                    )}
                  </div>
                  {qty === null && b.suggested > 0 && <span className="ss-help">Follows the suggestion as you change settings</span>}
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-cost">
                    Unit cost ({d.currency})
                  </label>
                  <input id="ro-cost" className="ss-input" type="number" min={0} step="0.01" name="unitCost" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-target">
                    Add to
                  </label>
                  <select id="ro-target" className="ss-select" name="target" value={targetValue} onChange={(e) => setTarget(e.target.value)}>
                    <option value="new">New draft purchase order</option>
                    {drafts.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.number} (draft, {x.lines} line{x.lines === 1 ? "" : "s"}
                        {x.source === "AUTO" ? ", automatic" : ""})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ro-notes">
                    Note to supplier
                  </label>
                  <textarea id="ro-notes" className="ss-textarea" name="notes" rows={2} placeholder="Optional" />
                </div>

                <div className="ss-summary">
                  <div>
                    <span>Supplier</span>
                    <b>{supplier?.name ?? "None"}</b>
                  </div>
                  <div>
                    <span>Expected</span>
                    <b>{shortDate(arrival)}</b>
                  </div>
                  <div>
                    <span>Lines</span>
                    <b>{1 + extraLines.length}</b>
                  </div>
                  <div className="big">
                    <span>Total</span>
                    <b>{fmt(total)}</b>
                  </div>
                </div>
                {supplier && supplier.minOrderValue > 0 && total < supplier.minOrderValue && (
                  <Badge tone="warning">
                    Below {supplier.name}&apos;s minimum order of {fmt(supplier.minOrderValue)}
                  </Badge>
                )}

                {d.canDraft ? (
                  <Btn type="submit" variant="primary" block loading={busy && nav.formData?.get("intent") === "create"} disabled={!supplier || quantity < 1}>
                    {targetValue === "new" ? "Create draft purchase order" : "Add to draft"}
                  </Btn>
                ) : (
                  <span className="ss-muted ss-small">
                    Draft purchase orders are on the Scale and Pro plans. <Link to="/app/billing">See plans</Link>
                  </span>
                )}
                <SubmitIntent />
                <Btn type="submit" variant="ghost" block loading={busy && nav.formData?.get("intent") === "save"} disabled={!supplier} onClick={setIntent("save")}>
                  Save supplier and rules only
                </Btn>
                <span className="ss-muted ss-small">Nothing is sent to the supplier until you approve the purchase order.</span>
              </div>
            </Card>
          </div>
        </div>
      </Form>
    </Page>
  );
}

/** One hidden intent field: "create" unless a button switches it just before submitting. */
function SubmitIntent() {
  return <input type="hidden" name="intent" defaultValue="create" id="ro-intent" />;
}
function setIntent(value: string) {
  return () => {
    const el = document.getElementById("ro-intent") as HTMLInputElement | null;
    if (el) {
      el.value = value;
      // Back to the default so pressing Enter later creates the order.
      setTimeout(() => (el.value = "create"), 0);
    }
  };
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
