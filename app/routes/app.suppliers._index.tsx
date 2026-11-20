import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { money, num, pct } from "../lib/format";
import { hasFeature } from "../lib/plans";
import { leadTimeStats, supplierScorecards } from "../lib/suppliers.server";
import { paging } from "../lib/paging";
import { Pager } from "../components/pager";
import { Badge, Row, Banner, Btn, Card, Empty, Input, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const pg = paging(url);
  const suppliers = (await db.supplier.findMany({ where: { shop: shop.id }, orderBy: { name: "asc" } })).filter(
    (s) => !q || `${s.name} ${s.email ?? ""} ${s.contactName ?? ""}`.toLowerCase().includes(q),
  );
  const page = pg.take ? suppliers.slice(pg.skip, pg.skip + pg.take) : suppliers;
  const stats = await leadTimeStats(shop.id);
  const counts = await db.variant.groupBy({ by: ["supplierId"], where: { shop: shop.id }, _count: true });
  const scorecardsAllowed = hasFeature(shop.plan, "supplierScorecards");
  const scorecards = scorecardsAllowed ? await supplierScorecards(shop.id) : [];
  return {
    currency: shop.currency,
    scorecardsAllowed,
    q,
    total: suppliers.length,
    page: pg.page,
    per: pg.per,
    suppliers: page.map((s) => {
      const st = stats.get(s.id);
      return {
        id: s.id,
        name: s.name,
        email: s.email,
        contactName: s.contactName,
        paymentTerms: s.paymentTerms,
        leadTime: st?.effective ?? s.defaultLeadTimeDays,
        drift: st && st.latest !== null && st.previous !== null ? st.latest - st.previous : 0,
        skus: counts.find((c) => c.supplierId === s.id)?._count ?? 0,
        categories: (s.categoryKey ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        scorecard: scorecards.find((x) => x.supplierId === s.id) ?? null,
      };
    }),
  };
};

export default function Suppliers() {
  const d = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const saved = params.get("saved");
  const deleted = params.get("deleted");

  return (
    <Page
      eyebrow="Supply"
      title="Supplier"
      accent="lead times"
      subtitle="Suppliers are created from your product vendors. When a supplier slips, every forecast behind it moves too."
      actions={
        <Btn href="/app/suppliers/new" variant="primary">
          + Add supplier
        </Btn>
      }
    >
      {saved && <Banner tone="success" title={`${saved} saved. Forecasts are updating.`} />}
      {deleted && <Banner tone="success" title={`${deleted} deleted.`} />}

      <Card
        title="Suppliers"
        meta={`${d.total} supplier${d.total === 1 ? "" : "s"}`}
        actions={
          <Form method="get" className="ss-search-inline">
            {params.get("per") && <input type="hidden" name="per" value={params.get("per")!} />}
            <Input type="search" name="q" placeholder="Search suppliers" defaultValue={d.q} aria-label="Search suppliers" style={{ width: 220 }} />
          </Form>
        }
        flush
      >
        {d.suppliers.length === 0 ? (
          <Empty heading={d.q ? "No suppliers match" : "No suppliers yet"}>
            {d.q ? "Try another name or email." : "Add your first supplier, or they are created from product vendors on import."}
          </Empty>
        ) : (
          <div className="ss-table-wrap">
            <table className="ss-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th className="num">SKUs</th>
                  <th className="num">Lead time</th>
                  <th>Preferred for</th>
                  <th>Terms</th>
                  {d.scorecardsAllowed && <th className="num">On time</th>}
                  {d.scorecardsAllowed && <th className="num">Fill rate</th>}
                  {d.scorecardsAllowed && <th className="num">Open orders</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.suppliers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="ss-item">
                        <Link to={`/app/suppliers/${s.id}`}>{s.name}</Link>
                        <span className="ss-sku">{[s.contactName, s.email].filter(Boolean).join(" · ") || "no contact yet"}</span>
                      </div>
                    </td>
                    <td className="num">{num(s.skus)}</td>
                    <td className="num">
                      <Badge tone={s.drift >= 3 ? "critical" : s.drift <= -3 ? "success" : "neutral"}>
                        {`${Math.round(s.leadTime)} d${s.drift >= 3 ? ` ↑${Math.round(s.drift)}` : s.drift <= -3 ? ` ↓${Math.round(-s.drift)}` : ""}`}
                      </Badge>
                    </td>
                    <td>
                      {s.categories.length ? (
                        <Row gap={4}>
                          {s.categories.map((c) => (
                            <Badge key={c} tone="info">
                              {c}
                            </Badge>
                          ))}
                        </Row>
                      ) : (
                        <span className="ss-muted ss-small">-</span>
                      )}
                    </td>
                    <td className="ss-small ss-text-2">{s.paymentTerms ?? "-"}</td>
                    {d.scorecardsAllowed && <td className="num">{pct(s.scorecard?.onTimeRate ?? null, 0)}</td>}
                    {d.scorecardsAllowed && <td className="num">{pct(s.scorecard?.fillRate ?? null, 0)}</td>}
                    {d.scorecardsAllowed && <td className="num">{money(s.scorecard?.openValue ?? 0, d.currency)}</td>}
                    <td className="num">
                      <Btn small variant="ghost" href={`/app/suppliers/${s.id}`}>
                        Edit
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.total > 0 && <Pager total={d.total} page={d.page} per={d.per} />}
      </Card>
      {!d.scorecardsAllowed && (
        <span className="ss-muted ss-small">Supplier scorecards (on-time rate, fill rate, open orders) are included on the Pro plan.</span>
      )}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
