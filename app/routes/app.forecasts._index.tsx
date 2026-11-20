import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { coverLabel, money, num, pct, shortId, variantLabel } from "../lib/format";
import { curveSummary, spotlightCandidates, stockCurve } from "../lib/curve.server";
import { leadTimeStats } from "../lib/suppliers.server";
import { SpotlightCard } from "../components/spotlight";
import { Pager } from "../components/pager";
import { paging } from "../lib/paging";
import { shortDate } from "../lib/dates";
import { hasFeature, planDef } from "../lib/plans";
import { Banner, Btn, Card, Empty, Input, Page, Pills, Row, Stack, StatusAction, SyncBanner, LocationPills } from "../components/ui";
import { DownloadButton } from "../components/download";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();
  const multi = hasFeature(shop.plan, "multiLocation");
  const locations = multi ? await db.location.findMany({ where: { shop: shop.id, isActive: true }, orderBy: { name: "asc" } }) : [];
  const picked = url.searchParams.get("location") ?? "";
  const selected = locations.some((l) => l.id === picked) ? picked : "";
  // With a single location its forecasts are the store-level ones.
  const location = locations.length > 1 ? selected : "";
  const pg = paging(url);

  let variantFilter: string[] | undefined;
  if (q) {
    const words = q.toLowerCase().split(/\s+/);
    const matches = (await db.variant.findMany({ where: { shop: shop.id } })).filter((v) => {
      const hay = `${v.productTitle} ${v.variantTitle ?? ""} ${v.sku ?? ""} ${v.vendor ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    variantFilter = matches.map((m) => m.id);
  }
  const where = {
    shop: shop.id,
    locationId: location,
    ...(status ? { status } : {}),
    ...(variantFilter ? { variantId: { in: variantFilter } } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    db.forecast.findMany({
      where,
      orderBy: [{ revenueAtRisk: "desc" }, { daysOfCover: "asc" }],
      take: pg.take,
      skip: pg.skip,
    }),
    db.forecast.count({ where }),
    db.forecast.groupBy({ by: ["status"], where: { shop: shop.id, locationId: location }, _count: true }),
  ]);
  const variants = new Map((await db.variant.findMany({ where: { id: { in: rows.map((r) => r.variantId) } } })).map((v) => [v.id, v]));
  const def = planDef(shop.plan);

  // Spotlight: one SKU's live stock curve, defaulting to the most revenue at risk.
  const candidates = await spotlightCandidates(shop.id);
  const spot = url.searchParams.get("spot");
  const chosen = spot ? `gid://shopify/ProductVariant/${spot}` : candidates[0]?.variantId;
  const curve = chosen ? await stockCurve(shop.id, chosen, { pastDays: 21 }) : null;
  const position = curve ? candidates.findIndex((c) => c.variantId === curve.variantId) : -1;
  const spotHref = (i: number) => {
    const qs = new URLSearchParams(url.searchParams);
    qs.set("spot", shortId(candidates[i].variantId));
    return `/app/forecasts?${qs}`;
  };

  // Live facts for the three points next to the card.
  const [allCount, highCount, latestAccuracy, leadTimes] = await Promise.all([
    db.forecast.count({ where: { shop: shop.id, locationId: "" } }),
    db.forecast.count({ where: { shop: shop.id, locationId: "", confidence: "HIGH" } }),
    db.accuracySnapshot.findFirst({ where: { shop: shop.id }, orderBy: { date: "desc" } }),
    leadTimeStats(shop.id),
  ]);
  const slipped = [...leadTimes.values()]
    .filter((s) => s.latest !== null && s.previous !== null && s.latestAt && Date.now() - s.latestAt.getTime() < 30 * 86_400_000)
    .map((s) => ({ name: s.name, from: Math.round(s.previous!), to: Math.round(s.latest!) }))
    .filter((s) => s.to - s.from >= 3)
    .sort((a, b) => b.to - b.from - (a.to - a.from))[0] ?? null;

  return {
    spotlight: curve
      ? {
          data: {
            variantId: curve.variantId,
            shortId: shortId(curve.variantId),
            label: curve.label,
            sku: curve.sku,
            status: curve.status,
            onHand: curve.onHand,
            onOrder: curve.onOrder,
            dailyRate14: curve.dailyRate14,
            leadTimeDays: curve.leadTimeDays,
            reorderPoint: curve.reorderPoint,
            suggestedQty: curve.suggestedQty,
            past: curve.past,
            future: curve.future,
            crossingDay: curve.crossingDay,
            leadTimeDay: curve.leadTimeDay,
            today: curve.today,
            summary: curveSummary(curve, 21),
          },
          position: position >= 0 ? `${position + 1}/${candidates.length}` : undefined,
          prevHref: position > 0 ? spotHref(position - 1) : undefined,
          nextHref: position >= 0 && position < candidates.length - 1 ? spotHref(position + 1) : undefined,
        }
      : null,
    facts: {
      forecast: allCount,
      high: highCount,
      accuracy: latestAccuracy?.accuracy ?? null,
      slipped,
    },
    currency: shop.currency,
    sync: { status: shop.syncStatus, stage: shop.syncStage, error: shop.syncError },
    canExport: hasFeature(shop.plan, "csvExport"),
    skuLimit: def && Number.isFinite(def.skuLimit) ? def.skuLimit : null,
    filters: { status, q, location: selected, page: pg.page, per: pg.per },
    total,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    multiLocation: multi,
    locations: locations.map((l) => ({ value: l.id, label: l.name })),
    rows: rows.map((r) => {
      const v = variants.get(r.variantId);
      return {
        variantId: r.variantId,
        label: v ? variantLabel(v) : r.variantId,
        sku: v?.sku ?? null,
        onHand: r.onHand,
        onOrder: r.onOrder,
        rate: r.dailyRate14,
        forecast: r.meanDaily,
        cover: r.daysOfCover,
        stockout: r.stockoutDate,
        reorderPoint: r.reorderPoint,
        suggested: r.suggestedQty,
        risk: r.revenueAtRisk,
        status: r.status,
        confidence: r.confidence,
      };
    }),
  };
};

export default function Forecasts() {
  const d = useLoaderData<typeof loader>();
  const extra: Record<string, string> = {};
  if (d.filters.q) extra.q = d.filters.q;
  if (d.filters.location) extra.location = d.filters.location;
  if (d.filters.per !== "20") extra.per = d.filters.per;
  const statusOptions = [
    { value: "", label: "All" },
    { value: "REORDER_NOW", label: "Reorder now", count: d.counts.REORDER_NOW ?? 0 },
    { value: "WATCH", label: "Watch", count: d.counts.WATCH ?? 0 },
    { value: "HEALTHY", label: "Healthy", count: d.counts.HEALTHY ?? 0 },
    { value: "OVERSTOCKED", label: "Overstocked", count: d.counts.OVERSTOCKED ?? 0 },
    { value: "NO_DATA", label: "No sales yet", count: d.counts.NO_DATA ?? 0 },
  ];

  const f = d.facts;
  return (
    <Page
      eyebrow="Forecasting"
      title="Predict before you"
      accent="run out"
      subtitle="Most inventory tools tell you what you have. StockSense tells you what you are about to not have, and how long you have to fix it."
      intro={
        <ul className="ss-points">
          <li>
            <h3>A curve per SKU, not a reorder point</h3>
            <p>
              Each variant gets a demand curve built from its own history, seasonality and promotion calendar, so a summer line and a staple are
              not treated the same way. <b>{num(f.forecast)} variants forecast</b> right now.
            </p>
          </li>
          <li>
            <h3>Supplier lead times built in</h3>
            <p>
              Cover is counted in days you can actually trade, not units on a shelf.{" "}
              {f.slipped ? (
                <>
                  <b>
                    {f.slipped.name} slipped from {f.slipped.from} days to {f.slipped.to}
                  </b>
                  , and every forecast behind it moved too.
                </>
              ) : (
                <>If a supplier slips, every forecast behind it moves too.</>
              )}
            </p>
          </li>
          <li>
            <h3>Confidence you can see</h3>
            <p>
              Every number ships with its confidence range, so you know which forecasts to act on and which need a human to look twice.{" "}
              {f.accuracy !== null ? (
                <b>
                  {pct(f.accuracy)} accurate over the last four weeks, {num(f.high)} SKUs at high confidence.
                </b>
              ) : (
                <b>Accuracy appears after four weeks of history.</b>
              )}
            </p>
          </li>
        </ul>
      }
      aside={
        d.spotlight ? (
          <SpotlightCard data={d.spotlight.data} position={d.spotlight.position} prevHref={d.spotlight.prevHref} nextHref={d.spotlight.nextHref} />
        ) : (
          <Card title="Projected units on hand">
            <Empty heading="No SKU to show yet">The live curve appears as soon as the first forecast is built.</Empty>
          </Card>
        )
      }
      actions={
        d.canExport ? (
          <DownloadButton href={`/app/forecasts/export?location=${encodeURIComponent(d.filters.location)}`} filename="stocksense-forecasts.csv">
            Export CSV
          </DownloadButton>
        ) : undefined
      }
    >
      <SyncBanner status={d.sync.status} stage={d.sync.stage} error={d.sync.error} />
      {d.skuLimit !== null && d.total >= d.skuLimit && !d.filters.status && !d.filters.q && (
        <Banner tone="warning" title={`Your plan forecasts your top ${num(d.skuLimit)} SKUs by revenue`}>
          Upgrade to forecast every variant you sell.
        </Banner>
      )}

      <Card flush>
        <div className="ss-card-body">
          <Stack tight>
            <Row between>
              <Pills base="/app/forecasts" param="status" value={d.filters.status} options={statusOptions} extra={extra} />
              <Form method="get">
                <div className="ss-input-group">
                  {d.filters.status && <input type="hidden" name="status" value={d.filters.status} />}
                  {d.filters.location && <input type="hidden" name="location" value={d.filters.location} />}
                  <Input type="search" name="q" placeholder="Search product, SKU or vendor" defaultValue={d.filters.q} aria-label="Search" style={{ width: 280 }} />
                  <Btn type="submit">Search</Btn>
                </div>
              </Form>
            </Row>
            <LocationPills
              base="/app/forecasts"
              multi={d.multiLocation}
              value={d.filters.location}
              locations={d.locations}
              extra={{ ...(d.filters.q ? { q: d.filters.q } : {}), ...(d.filters.status ? { status: d.filters.status } : {}) }}
            />
          </Stack>
        </div>

        {d.rows.length === 0 ? (
          <Empty heading="No forecasts match">Try another filter, or wait for the first rebuild to finish.</Empty>
        ) : (
          <div className="ss-table-wrap">
            <table className="ss-table">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th className="num">On hand</th>
                  <th className="num">Rate / day</th>
                  <th className="num">Cover</th>
                  <th className="num">Runs out</th>
                  <th className="num">Reorder at</th>
                  <th className="num">Suggested</th>
                  <th className="num">At risk</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.variantId}>
                    <td>
                      <div className="ss-item">
                        <Link to={`/app/forecasts/${shortId(r.variantId)}`}>{r.label}</Link>
                        <span className="ss-sku">
                          {r.sku ?? "no sku"} · {r.confidence.toLowerCase()} confidence
                        </span>
                      </div>
                    </td>
                    <td className="num">
                      {num(r.onHand)}
                      {r.onOrder > 0 && <span className="ss-muted"> +{num(r.onOrder)}</span>}
                    </td>
                    <td className="num">{num(r.rate, 1)}</td>
                    <td className="num">{coverLabel(r.cover)}</td>
                    <td className="num">{r.stockout ? shortDate(r.stockout) : "-"}</td>
                    <td className="num">{num(r.reorderPoint)}</td>
                    <td className="num">{r.suggested ? <span className="ss-accent">{num(r.suggested)}</span> : "-"}</td>
                    <td className="num">{r.risk > 0 ? money(r.risk, d.currency) : "-"}</td>
                    <td>
                      <StatusAction status={r.status} variantId={r.variantId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={d.total} page={d.filters.page} per={d.filters.per} />
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
