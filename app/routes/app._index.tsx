import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { dashboardData } from "../lib/dashboard.server";
import { coverLabel, money, num, pct, shortId } from "../lib/format";
import { hasFeature } from "../lib/plans";
import { timeAgo } from "../lib/dates";
import { WeeklyBars } from "../components/charts";
import { Badge, Btn, Card, Empty, Kpi, KpiStrip, List, ListRow, Page, Row, Split, Stack, StatusAction, SyncBanner, LocationPills } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const multi = hasFeature(shop.plan, "multiLocation");
  const locations = multi ? await db.location.findMany({ where: { shop: shop.id, isActive: true }, orderBy: { name: "asc" } }) : [];
  const picked = url.searchParams.get("location") ?? "";
  const location = locations.some((l) => l.id === picked) ? picked : "";
  // With a single location its numbers are the store totals.
  const data = await dashboardData(shop.id, locations.length > 1 ? location : "");
  return {
    shop: {
      currency: shop.currency,
      syncStatus: shop.syncStatus,
      syncStage: shop.syncStage,
      syncError: shop.syncError,
      lastForecastAt: shop.lastForecastAt?.toISOString() ?? null,
    },
    multiLocation: multi,
    locations: locations.map((l) => ({ value: l.id, label: l.name })),
    location,
    ...data,
  };
};

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  const fmt = (n: number) => money(n, d.shop.currency);
  const k = d.kpis;
  const ready = k.skusTracked > 0;
  const rebuilt = d.shop.lastForecastAt ? `rebuilt ${timeAgo(d.shop.lastForecastAt)} · ${num(k.skusTracked)} SKUs` : "not built yet";

  return (
    <Page
      eyebrow={
        <>
          Demand forecasting for <b>real inventory</b>
        </>
      }
      title="Inventory"
      accent="overview"
      subtitle="Everything you need to decide what to order this morning, in one place."
      actions={
        <>
          <Btn href="/app/forecasts">All forecasts</Btn>
          <Btn href="/app/purchase-orders" variant="primary">
            Purchase orders
          </Btn>
        </>
      }
    >
      <SyncBanner status={d.shop.syncStatus} stage={d.shop.syncStage} error={d.shop.syncError} />

      <Row between>
        <LocationPills base="/app" multi={d.multiLocation} value={d.location} locations={d.locations} />
        <span className="ss-card-meta">{rebuilt}</span>
      </Row>

      <KpiStrip>
        <Kpi label="SKUs tracked" value={num(k.skusTracked)} note={`${k.critical} critical`} tone={k.critical ? "critical" : "success"} />
        <Kpi
          label="Need reordering"
          value={num(k.needReorder)}
          note={k.draftsReady ? `${k.draftsReady} draft${k.draftsReady > 1 ? "s" : ""} ready` : "no drafts"}
          tone={k.draftsReady ? "warning" : "neutral"}
        />
        <Kpi label="Cash in overstock" value={fmt(k.cashInOverstock)} note={`${k.overstockSkus} SKUs`} tone="accent" />
        <Kpi
          label="Forecast accuracy"
          value={pct(k.accuracy)}
          note={k.accuracyDelta !== null ? `${k.accuracyDelta >= 0 ? "+" : ""}${(k.accuracyDelta * 100).toFixed(1)} this month` : "learning"}
          tone={k.accuracyDelta !== null && k.accuracyDelta < 0 ? "warning" : "success"}
        />
        <Kpi label="Revenue protected" value={fmt(k.revenueProtected)} note="last 90 days" tone="success" />
      </KpiStrip>

      {!ready ? (
        <Card>
          <Empty heading="Forecasts are on their way">
            The first forecast is ready within a day for most catalogs. Nothing to tag or clean up first.
          </Empty>
        </Card>
      ) : (
        <>
          <Split>
            <Card
              title="Units sold against forecast"
              subtitle="Last 12 weeks, all channels. The accent bars are the forecast window."
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
              <WeeklyBars data={d.chart} />
            </Card>
            <Card title="Running low" subtitle="Days of cover at the forecast rate">
              {d.runningLow.length ? (
                <List>
                  {d.runningLow.map((r) => (
                    <ListRow
                      key={r.variantId}
                      left={
                        <Link className="ss-link ss-mono ss-small" to={`/app/forecasts/${shortId(r.variantId)}`}>
                          {r.sku}
                        </Link>
                      }
                      right={<Badge tone={r.cover < r.leadTime ? "critical" : r.cover < r.leadTime + 14 ? "warning" : "success"}>{coverLabel(r.cover)}</Badge>}
                    />
                  ))}
                </List>
              ) : (
                <span className="ss-muted">Nothing is selling fast enough to run low.</span>
              )}
            </Card>
          </Split>

          <Split>
            <Card title="Attention needed" subtitle="Sorted by revenue at risk" flush>
              <div className="ss-table-wrap">
                <table className="ss-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">On hand</th>
                      <th className="num">Cover</th>
                      <th className="num">At risk</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.attention.map((a) => (
                      <tr key={a.variantId}>
                        <td>
                          <div className="ss-item">
                            <Link to={`/app/forecasts/${shortId(a.variantId)}`}>{a.label}</Link>
                            {a.sku && <span className="ss-sku">{a.sku}</span>}
                          </div>
                        </td>
                        <td className="num">{num(a.onHand)}</td>
                        <td className="num">{coverLabel(a.cover)}</td>
                        <td className="num">{a.revenueAtRisk > 0 ? fmt(a.revenueAtRisk) : "-"}</td>
                        <td>
                          <StatusAction status={a.status} variantId={a.variantId} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Stack>
              <Card title="Suggested order" subtitle={d.suggested ? `${d.suggested.number} · ${d.suggested.supplier}` : undefined}>
                {d.suggested ? (
                  <Stack tight>
                    <List>
                      {d.suggested.lines.map((l) => (
                        <ListRow key={l.label} left={<span className="ss-text-2 ss-small">{l.label}</span>} right={<span className="ss-mono">{num(l.quantity)}</span>} />
                      ))}
                      {d.suggested.moreLines > 0 && (
                        <ListRow left={<span className="ss-muted ss-small">+ {d.suggested.moreLines} more lines</span>} right="" />
                      )}
                      <ListRow left={<span className="ss-muted">Order total</span>} right={<span className="ss-mono ss-strong">{fmt(d.suggested.total)}</span>} />
                    </List>
                    <Btn href={`/app/purchase-orders/${d.suggested.id}`} variant="primary" block>
                      Review and approve
                    </Btn>
                  </Stack>
                ) : (
                  <span className="ss-muted">No draft purchase orders right now.</span>
                )}
              </Card>

              <Card title="Supplier lead times" subtitle="Rolling 90-day average, or the latest delivery if slower">
                {d.leadTimes.length ? (
                  <List>
                    {d.leadTimes.map((s) => (
                      <ListRow
                        key={s.id}
                        left={<span className="ss-mono ss-small">{s.name}</span>}
                        right={
                          <Badge tone={s.drift >= 3 ? "critical" : s.drift <= -3 ? "success" : "neutral"}>
                            {`${Math.round(s.days)} d${s.drift >= 3 ? ` ↑${Math.round(s.drift)}` : s.drift <= -3 ? ` ↓${Math.round(-s.drift)}` : ""}`}
                          </Badge>
                        }
                      />
                    ))}
                  </List>
                ) : (
                  <span className="ss-muted">No suppliers yet.</span>
                )}
              </Card>
            </Stack>
          </Split>
        </>
      )}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
