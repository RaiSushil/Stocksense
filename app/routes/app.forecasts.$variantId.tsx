import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { addDays, diffDays, todayIn } from "../lib/dates";
import { coverLabel, money, num, pct, variantLabel } from "../lib/format";
import { hasFeature } from "../lib/plans";
import { createDraftPo } from "../lib/po.server";
import { inBackground, runRebuild } from "../lib/jobs.server";
import { DemandChart, StockCurve } from "../components/charts";
import { curveSummary, stockCurve } from "../lib/curve.server";
import { Badge, Banner, Btn, Card, FormGrid, Grid, Input, List, ListRow, Page, Result, Row, Select, Split, Stack, StatusBadge } from "../components/ui";

const gidOf = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const variantId = gidOf(params.variantId!);
  const variant = await db.variant.findFirst({ where: { shop: shop.id, id: variantId }, include: { supplier: true } });
  if (!variant) throw new Response("Not found", { status: 404 });
  const forecasts = await db.forecast.findMany({ where: { shop: shop.id, variantId } });
  const f = forecasts.find((x) => x.locationId === "") ?? null;
  const today = todayIn(shop.timezone);
  const locations = new Map((await db.location.findMany({ where: { shop: shop.id } })).map((l) => [l.id, l.name]));
  const levels = await db.inventoryLevel.findMany({ where: { shop: shop.id, variantId } });
  const suppliers = await db.supplier.findMany({ where: { shop: shop.id }, orderBy: { name: "asc" } });

  // Weekly actual sales for the last 12 weeks.
  // The last bar includes today so new orders show up straight away.
  const start = addDays(today, -83);
  const sales = await db.salesDaily.groupBy({ by: ["date"], where: { variantId, date: { gte: start, lte: today } }, _sum: { units: true } });
  const actual = new Array(12).fill(0);
  for (const s of sales) {
    const w = Math.floor(diffDays(s.date, start) / 7);
    if (w >= 0 && w < 12) actual[w] += s._sum.units ?? 0;
  }

  let charts = null;
  if (f) {
    const series: number[] = JSON.parse(f.series);
    const lower: number[] = JSON.parse(f.lower);
    const upper: number[] = JSON.parse(f.upper);
    const weekly = (arr: number[]) => Array.from({ length: 8 }, (_, w) => arr.slice(w * 7, w * 7 + 7).reduce((a, b) => a + b, 0));
    charts = {
      weeklyForecast: weekly(series),
      weeklyLow: weekly(lower),
      weeklyHigh: weekly(upper),
    };
  }

  const curve = f ? await stockCurve(shop.id, variantId, { pastDays: 21, minFuture: 30, maxFuture: 90 }) : null;

  const draft = variant.supplierId
    ? await db.purchaseOrder.findFirst({ where: { shop: shop.id, supplierId: variant.supplierId, status: "DRAFT" }, orderBy: { createdAt: "desc" } })
    : null;
  const openPos = await db.purchaseOrderLine.findMany({
    where: { variantId, po: { shop: shop.id, status: { in: ["DRAFT", "APPROVED", "SENT", "PARTIAL"] } } },
    include: { po: true },
  });

  return {
    currency: shop.currency,
    canDraft: hasFeature(shop.plan, "draftPurchaseOrders"),
    variant: {
      id: variant.id,
      label: variantLabel(variant),
      sku: variant.sku,
      vendor: variant.vendor,
      price: variant.price,
      unitCost: variant.unitCost,
      supplierId: variant.supplierId,
      supplierName: variant.supplier?.name ?? null,
      casePack: variant.casePack,
      minOrderQty: variant.minOrderQty,
      leadTimeOverride: variant.leadTimeOverride,
      productId: variant.productId,
    },
    forecast: f && {
      ...f,
      computedAt: f.computedAt.toISOString(),
      series: undefined,
      lower: undefined,
      upper: undefined,
    },
    charts,
    curve: curve && { ...curve, summary: curveSummary(curve, 21) },
    actual,
    stock: levels.map((l) => ({ location: locations.get(l.locationId) ?? "Location", available: l.available, incoming: l.incoming })),
    byLocation: forecasts
      .filter((x) => x.locationId)
      .map((x) => ({ location: locations.get(x.locationId) ?? "Location", cover: x.daysOfCover, status: x.status, suggested: x.suggestedQty, onHand: x.onHand })),
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })),
    draft: draft ? { id: draft.id, number: draft.number } : null,
    openPos: openPos.map((l) => ({ id: l.po.id, number: l.po.number, status: l.po.status, qty: l.quantity, expected: l.po.expectedAt?.toISOString() ?? null })),
    today,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const variantId = gidOf(params.variantId!);
  const variant = await db.variant.findFirstOrThrow({ where: { shop: shop.id, id: variantId } });
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "settings") {
    const int = (k: string) => {
      const v = String(form.get(k) ?? "").trim();
      return v === "" ? null : Math.max(0, Math.round(Number(v)));
    };
    const cost = String(form.get("unitCost") ?? "").trim();
    const supplierRaw = String(form.get("supplierId") || "");
    // Only this store's suppliers can be chosen.
    const supplier = supplierRaw ? await db.supplier.findFirst({ where: { id: supplierRaw, shop: shop.id }, select: { id: true } }) : null;
    if (supplierRaw && !supplier) return { error: "That supplier was not found." };
    await db.variant.update({
      where: { id: variant.id },
      data: {
        supplierId: supplier?.id ?? null,
        casePack: Math.max(1, int("casePack") ?? 1),
        minOrderQty: int("minOrderQty") ?? 0,
        leadTimeOverride: int("leadTimeOverride"),
        unitCost: cost === "" ? null : Number(cost),
      },
    });
    inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
    return { ok: "Saved. The forecast is recalculating, refresh in a moment." };
  }

  if (intent === "draft") {
    if (!hasFeature(shop.plan, "draftPurchaseOrders")) return { error: "Draft purchase orders need the Scale or Pro plan." };
    if (!variant.supplierId) return { error: "Assign a supplier first." };
    const qty = Math.max(1, Math.round(Number(form.get("quantity") ?? 0)));
    const existing = await db.purchaseOrder.findFirst({
      where: { shop: shop.id, supplierId: variant.supplierId, status: "DRAFT" },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      const line = existing.lines.find((l) => l.variantId === variant.id);
      if (line) await db.purchaseOrderLine.update({ where: { id: line.id }, data: { quantity: qty } });
      else await db.purchaseOrderLine.create({ data: { poId: existing.id, variantId: variant.id, quantity: qty, unitCost: variant.unitCost ?? 0 } });
      await db.purchaseOrder.update({ where: { id: existing.id }, data: { source: "MANUAL" } });
      throw redirect(`/app/purchase-orders/${existing.id}`);
    }
    const po = await createDraftPo(shop.id, { supplierId: variant.supplierId, source: "MANUAL", lines: [{ variantId: variant.id, quantity: qty }] });
    throw redirect(`/app/purchase-orders/${po.id}`);
  }
  return { error: "Unknown action" };
};

export default function VariantForecast() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const f = d.forecast;
  const fmt = (n: number) => money(n, d.currency);

  return (
    <Page
      back={{ href: "/app/forecasts", label: "Forecasts" }}
      eyebrow={d.variant.sku ?? "No SKU"}
      title={d.variant.label}
      subtitle={f ? undefined : "No forecast yet"}
      actions={
        <Row>
          {f && <StatusBadge status={f.status} />}
          <Btn variant="primary" href={`/app/reorder/${encodeURIComponent(d.variant.id.split("/").pop()!)}`}>
            Reorder
          </Btn>
        </Row>
      }
    >
      <Result data={result} />

      {!f ? (
        <Banner tone="info" title="No forecast yet">
          This variant has no sales history or stock, or it is outside your plan&apos;s SKU limit.
        </Banner>
      ) : (
        <>
          <Split>
            <Card
              title="Projected units on hand"
              subtitle={d.curve ? `${d.curve.summary} Last 21 days rebuilt from sales; shaded band is the 80% range.` : undefined}
            >
              {d.curve && (
                <StockCurve
                  past={d.curve.past}
                  now={d.curve.onHand}
                  future={d.curve.future}
                  futureLow={d.curve.futureLow}
                  futureHigh={d.curve.futureHigh}
                  reorderPoint={d.curve.reorderPoint}
                  crossingDay={d.curve.crossingDay}
                  leadTimeDay={d.curve.leadTimeDay}
                  today={d.curve.today}
                  height={320}
                  width={820}
                  showAxis
                />
              )}
            </Card>
            <Card title="The numbers" flush>
              <div className="ss-card-body">
                <List>
                  <ListRow left={<span className="ss-stat-label">Units on hand</span>} right={<span className="ss-mono">{num(f.onHand)}{f.onOrder ? ` +${num(f.onOrder)}` : ""}</span>} />
                  <ListRow left={<span className="ss-stat-label">Daily rate, 14-day avg</span>} right={<span className="ss-mono">{num(f.dailyRate14, 1)}</span>} />
                  <ListRow left={<span className="ss-stat-label">Forecast per day, next 30</span>} right={<span className="ss-mono">{num(f.meanDaily, 1)}</span>} />
                  <ListRow left={<span className="ss-stat-label">Days of cover</span>} right={<span className="ss-mono">{coverLabel(f.daysOfCover)}</span>} />
                  <ListRow left={<span className="ss-stat-label">Supplier lead time</span>} right={<span className="ss-mono">{Math.round(f.leadTimeDays)} days</span>} />
                  <ListRow left={<span className="ss-stat-label">Reorder point</span>} right={<span className="ss-mono">{num(f.reorderPoint)}</span>} />
                  <ListRow left={<span className="ss-stat-label">Safety stock</span>} right={<span className="ss-mono">{num(f.safetyStock)}</span>} />
                  <ListRow left={<span className="ss-stat-label">Revenue at risk</span>} right={<span className="ss-mono">{f.revenueAtRisk > 0 ? fmt(f.revenueAtRisk) : "-"}</span>} />
                  <ListRow
                    left={<span className="ss-stat-label">Confidence</span>}
                    right={<Badge tone={f.confidence === "HIGH" ? "success" : f.confidence === "LOW" ? "warning" : "info"}>{`${f.confidence.toLowerCase()}${f.accuracy !== null ? ` · ${pct(f.accuracy)}` : ""}`}</Badge>}
                  />
                  <ListRow
                    left={<span className="ss-stat-label">Suggested order</span>}
                    right={f.suggestedQty ? <Badge tone="accent">{`${num(f.suggestedQty)} units`}</Badge> : <span className="ss-muted">none needed</span>}
                  />
                </List>
              </div>
            </Card>
          </Split>

          {d.charts && (
            <Card
              title="Weekly demand"
              subtitle={`Last 12 weeks sold and the next 8 weeks forecast with its 80% range. Method: ${f.method.replace("_", " ").toLowerCase()}, ${f.historyDays} days of history.`}
              actions={
                <div className="ss-legend">
                  <span>
                    <i style={{ background: "var(--ss-bar)" }} />
                    Sold
                  </span>
                  <span>
                    <i style={{ background: "var(--ss-accent)" }} />
                    Forecast
                  </span>
                </div>
              }
            >
              <DemandChart actual={d.actual} forecast={d.charts.weeklyForecast} low={d.charts.weeklyLow} high={d.charts.weeklyHigh} />
            </Card>
          )}
        </>
      )}

      <Grid min={320}>
        <Card
          title="Order"
          actions={
            <Link className="ss-link ss-small" to={`/app/reorder/${encodeURIComponent(d.variant.id.split("/").pop()!)}`}>
              Compare suppliers and quantities →
            </Link>
          }
        >
          <Stack tight>
            {d.openPos.length > 0 && (
              <List>
                {d.openPos.map((p) => (
                  <ListRow
                    key={p.id}
                    left={
                      <Link className="ss-link ss-mono" to={`/app/purchase-orders/${p.id}`}>
                        {p.number}
                      </Link>
                    }
                    right={<span className="ss-small ss-muted">{`${num(p.qty)} units · ${p.status.toLowerCase()}`}</span>}
                  />
                ))}
              </List>
            )}
            {d.canDraft ? (
              <Form method="post">
                <input type="hidden" name="intent" value="draft" />
                <div className="ss-input-group">
                  <Input label="Quantity" type="number" name="quantity" min={1} defaultValue={String(f?.suggestedQty || d.variant.casePack || 1)} className="num" />
                  <Btn type="submit" variant="primary" loading={busy} disabled={!d.variant.supplierId}>
                    {d.draft ? `Add to ${d.draft.number}` : "Create draft PO"}
                  </Btn>
                </div>
                {!d.variant.supplierId && <p className="ss-help">Assign a supplier below first.</p>}
              </Form>
            ) : (
              <span className="ss-muted">Draft purchase orders are on the Scale and Pro plans.</span>
            )}
          </Stack>
        </Card>

        <Card title="Stock by location">
          {d.stock.length || d.byLocation.length ? (
            <List>
              {d.stock.map((s) => (
                <ListRow
                  key={s.location}
                  left={<span>{s.location}</span>}
                  right={<span className="ss-mono">{`${num(s.available)} avail${s.incoming ? ` · ${num(s.incoming)} in` : ""}`}</span>}
                />
              ))}
              {d.byLocation.map((l) => (
                <ListRow
                  key={`f-${l.location}`}
                  left={<span className="ss-muted">{l.location} forecast</span>}
                  right={
                    <Row gap={8}>
                      <span className="ss-mono ss-small">{coverLabel(l.cover)}</span>
                      <StatusBadge status={l.status} />
                    </Row>
                  }
                />
              ))}
            </List>
          ) : (
            <span className="ss-muted">Not stocked at any location.</span>
          )}
        </Card>
      </Grid>

      <Card title="Ordering settings" subtitle="Saving recalculates this forecast in the background.">
        <Form method="post">
          <input type="hidden" name="intent" value="settings" />
          <Stack>
            <FormGrid>
              <Select label="Supplier" name="supplierId" defaultValue={d.variant.supplierId ?? ""}>
                <option value="">No supplier</option>
                {d.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Input label="Lead time override (days)" type="number" min={0} name="leadTimeOverride" defaultValue={d.variant.leadTimeOverride?.toString() ?? ""} help="Leave empty to use the supplier's" />
              <Input label="Case pack" type="number" min={1} name="casePack" defaultValue={String(d.variant.casePack)} help="Orders round up to this" />
              <Input label="Minimum order" type="number" min={0} name="minOrderQty" defaultValue={String(d.variant.minOrderQty)} />
              <Input label="Unit cost" type="number" min={0} step="0.01" name="unitCost" defaultValue={d.variant.unitCost?.toString() ?? ""} help="From Shopify cost per item" />
            </FormGrid>
            <div>
              <Btn type="submit" variant="primary" loading={busy}>
                Save and recalculate
              </Btn>
            </div>
          </Stack>
        </Form>
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
