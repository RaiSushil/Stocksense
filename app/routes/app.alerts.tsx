import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { timeAgo } from "../lib/dates";
import { money, shortId } from "../lib/format";
import { ALERT_TYPE_LABEL, type AlertType } from "../lib/alerts/rules";
import { paging } from "../lib/paging";
import { Pager } from "../components/pager";
import { hasFeature } from "../lib/plans";
import { Badge, Banner, Btn, Card, Empty, Page, Pills, Row, Stack } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "OPEN";
  const pg = paging(url);
  const all = await db.alert.findMany({
    where: { shop: shop.id, status },
    orderBy: [{ revenueAtRisk: "desc" }, { createdAt: "desc" }],
  });
  const sev = (s: string) => (s === "CRITICAL" ? 0 : s === "WARNING" ? 1 : 2);
  all.sort((a, b) => sev(a.severity) - sev(b.severity) || b.revenueAtRisk - a.revenueAtRisk);
  const alerts = pg.take ? all.slice(pg.skip, pg.skip + pg.take) : all;
  const counts = await db.alert.groupBy({ by: ["status"], where: { shop: shop.id }, _count: true });
  return {
    currency: shop.currency,
    status,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    critical: all.filter((a) => a.severity === "CRITICAL").length,
    total: all.length,
    page: pg.page,
    per: pg.per,
    lockedTypes: [
      !hasFeature(shop.plan, "velocityAlerts") ? "velocity" : null,
      !hasFeature(shop.plan, "leadTimeAlerts") ? "lead-time" : null,
    ].filter(Boolean),
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type as AlertType,
      severity: a.severity,
      title: a.title,
      message: a.message,
      revenueAtRisk: a.revenueAtRisk,
      variantId: a.variantId,
      supplierId: a.supplierId,
      poId: a.poId,
      createdAt: a.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const form = await request.formData();
  const id = String(form.get("id"));
  const intent = form.get("intent");
  if (intent === "dismiss") await db.alert.updateMany({ where: { id, shop: shop.id }, data: { status: "DISMISSED" } });
  if (intent === "reopen") await db.alert.updateMany({ where: { id, shop: shop.id }, data: { status: "OPEN" } });
  return null;
};

export default function Alerts() {
  const d = useLoaderData<typeof loader>();
  return (
    <Page
      eyebrow="Alerts"
      title="Alerts that"
      accent="actually matter"
      subtitle="Ranked by what it costs you. StockSense only interrupts you when something changed that you still have time to act on."
    >
      {d.lockedTypes.length > 0 && (
        <Banner tone="info" title="More alert types on Scale and Pro">
          Velocity alerts (same day) and lead-time drift alerts are included from the Scale plan.
        </Banner>
      )}
      <Pills
        base="/app/alerts"
        param="status"
        value={d.status}
        options={[
          { value: "OPEN", label: "Open", count: d.counts.OPEN ?? 0 },
          { value: "DISMISSED", label: "Dismissed", count: d.counts.DISMISSED ?? 0 },
          { value: "RESOLVED", label: "Resolved", count: d.counts.RESOLVED ?? 0 },
        ]}
      />
      <Card title="Alerts" meta={`${d.total} ${d.status.toLowerCase()} · ${d.critical} critical`} flush>
        {d.alerts.length === 0 ? (
          <Empty heading="Nothing needs you right now">New alerts appear here and in your email or Slack.</Empty>
        ) : (
          <div>
            {d.alerts.map((a) => (
              <div className="ss-alert" key={a.id}>
                <span className={`ss-alert-dot ${a.severity === "CRITICAL" ? "critical" : a.severity === "WARNING" ? "warning" : "info"}`} />
                <div className="ss-alert-main">
                  <Row gap={8}>
                    {a.variantId ? (
                      <Link className="ss-link" to={`/app/forecasts/${shortId(a.variantId)}`}>
                        {a.title}
                      </Link>
                    ) : a.supplierId ? (
                      <Link className="ss-link" to="/app/suppliers">
                        {a.title}
                      </Link>
                    ) : (
                      <span className="ss-strong">{a.title}</span>
                    )}
                    <Badge tone={a.severity === "CRITICAL" ? "critical" : a.severity === "WARNING" ? "warning" : "info"}>
                      {(ALERT_TYPE_LABEL[a.type] ?? a.type).toLowerCase()}
                    </Badge>
                  </Row>
                  <span className="ss-text-2 ss-small">{a.message}</span>
                  {a.revenueAtRisk > 0 && <span className="ss-sku">{money(a.revenueAtRisk, d.currency)} at risk</span>}
                </div>
                <Stack tight style={{ alignItems: "flex-end" }}>
                  <span className="ss-alert-time">{timeAgo(a.createdAt)}</span>
                  <Row gap={4}>
                    {a.variantId && ["STOCKOUT_RISK", "REORDER_POINT", "VELOCITY_SHIFT"].includes(a.type) && d.status === "OPEN" && (
                      <Btn small variant="primary" href={`/app/reorder/${shortId(a.variantId)}`}>
                        Reorder
                      </Btn>
                    )}
                    {a.poId && (
                      <Btn small variant="ghost" href={`/app/purchase-orders/${a.poId}`}>
                        View PO
                      </Btn>
                    )}
                    {d.status !== "RESOLVED" && (
                      <Form method="post">
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="intent" value={d.status === "OPEN" ? "dismiss" : "reopen"} />
                        <Btn small variant="ghost" type="submit">
                          {d.status === "OPEN" ? "Dismiss" : "Reopen"}
                        </Btn>
                      </Form>
                    )}
                  </Row>
                </Stack>
              </div>
            ))}
          </div>
        )}
        {d.total > 0 && <Pager total={d.total} page={d.page} per={d.per} />}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
