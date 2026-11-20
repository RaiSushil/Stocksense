import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { money, num, PO_STATUS_TONE } from "../lib/format";
import { hasFeature } from "../lib/plans";
import { createDraftPo, poTotal, syncAutoDrafts } from "../lib/po.server";
import { paging } from "../lib/paging";
import { Pager } from "../components/pager";
import { Badge, Btn, Card, Empty, Page, Pills, Row, Select, UpgradeNotice } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "OPEN";
  const pg = paging(url);
  const where =
    status === "OPEN"
      ? { shop: shop.id, status: { in: ["DRAFT", "APPROVED", "SENT", "PARTIAL"] } }
      : { shop: shop.id, status: { in: ["RECEIVED", "CANCELLED"] } };
  const [pos, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      include: { lines: true, supplier: true },
      orderBy: { createdAt: "desc" },
      take: pg.take,
      skip: pg.skip,
    }),
    db.purchaseOrder.count({ where }),
  ]);
  const suppliers = await db.supplier.findMany({ where: { shop: shop.id }, orderBy: { name: "asc" } });
  return {
    currency: shop.currency,
    allowed: hasFeature(shop.plan, "draftPurchaseOrders"),
    status,
    total,
    page: pg.page,
    per: pg.per,
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })),
    pos: pos.map((p) => ({
      id: p.id,
      number: p.number,
      supplier: p.supplier.name,
      status: p.status,
      source: p.source,
      lines: p.lines.length,
      units: p.lines.reduce((s, l) => s + l.quantity, 0),
      total: poTotal(p.lines),
      expectedAt: p.expectedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  if (!hasFeature(shop.plan, "draftPurchaseOrders")) return null;
  const form = await request.formData();
  if (form.get("intent") === "refresh") {
    await syncAutoDrafts(shop.id);
    return null;
  }
  if (form.get("intent") === "create") {
    const supplierId = String(form.get("supplierId"));
    // Start from the supplier's variants that need ordering; the merchant edits from there.
    const needs = await db.forecast.findMany({
      where: { shop: shop.id, locationId: "", suggestedQty: { gt: 0 }, variantId: { in: (await db.variant.findMany({ where: { shop: shop.id, supplierId }, select: { id: true } })).map((v) => v.id) } },
    });
    if (!needs.length) {
      const any = await db.variant.findFirst({ where: { shop: shop.id, supplierId } });
      if (!any) return null;
      const po = await createDraftPo(shop.id, { supplierId, source: "MANUAL", lines: [{ variantId: any.id, quantity: Math.max(1, any.casePack) }] });
      throw redirect(`/app/purchase-orders/${po.id}`);
    }
    const po = await createDraftPo(shop.id, {
      supplierId,
      source: "MANUAL",
      lines: needs.map((n) => ({ variantId: n.variantId, quantity: n.suggestedQty })),
    });
    throw redirect(`/app/purchase-orders/${po.id}`);
  }
  return null;
};

const label = (s: string) => ({ DRAFT: "Draft", APPROVED: "Approved", SENT: "Ordered", PARTIAL: "Partly received", RECEIVED: "Received", CANCELLED: "Cancelled" })[s] ?? s;

export default function PurchaseOrders() {
  const d = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const intent = busy ? String(nav.formData?.get("intent") ?? "") : "";

  if (!d.allowed && !d.pos.length) {
    return (
      <Page eyebrow="Reorder" title="Purchase" accent="orders">
        <UpgradeNotice feature="draftPurchaseOrders">
          StockSense writes the purchase order for you, with quantities, supplier and expected delivery date filled in, then waits for your
          approval.
        </UpgradeNotice>
      </Page>
    );
  }

  return (
    <Page
      eyebrow="Reorder"
      title="Purchase"
      accent="orders"
      subtitle="Drafts are written from the latest forecast. Nothing is sent to a supplier until you approve it."
      actions={
        d.allowed ? (
          <Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <Btn type="submit" loading={intent === "refresh"}>
              Refresh suggested drafts
            </Btn>
          </Form>
        ) : undefined
      }
    >
      <Row between>
        <Pills
          base="/app/purchase-orders"
          param="status"
          value={d.status}
          options={[
            { value: "OPEN", label: "Open" },
            { value: "CLOSED", label: "Closed" },
          ]}
        />
        {d.allowed && (
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div className="ss-input-group">
              <Select name="supplierId" aria-label="Supplier for the new purchase order">
                {d.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Btn type="submit" variant="primary" disabled={!d.suppliers.length} loading={intent === "create"}>
                New purchase order
              </Btn>
            </div>
          </Form>
        )}
      </Row>

      <Card flush>
        {d.pos.length === 0 ? (
          <Empty heading={d.status === "OPEN" ? "No open purchase orders" : "No closed purchase orders yet"}>
            Drafts appear here automatically when a SKU reaches its reorder point.
          </Empty>
        ) : (
          <div className="ss-table-wrap">
            <table className="ss-table">
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th className="num">Lines</th>
                  <th className="num">Units</th>
                  <th className="num">Total</th>
                  <th className="num">Expected</th>
                </tr>
              </thead>
              <tbody>
                {d.pos.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="ss-item">
                        <Link className="ss-mono" to={`/app/purchase-orders/${p.id}`}>
                          {p.number}
                        </Link>
                        <span className="ss-sku">
                          {p.source === "AUTO" ? "suggested by stocksense" : p.source === "ASK" ? "drafted from ask" : p.source === "API" ? "created by api" : "manual"}
                        </span>
                      </div>
                    </td>
                    <td>{p.supplier}</td>
                    <td>
                      <Badge tone={PO_STATUS_TONE[p.status]}>{label(p.status).toLowerCase()}</Badge>
                    </td>
                    <td className="num">{p.lines}</td>
                    <td className="num">{num(p.units)}</td>
                    <td className="num">{money(p.total, d.currency)}</td>
                    <td className="num">{p.expectedAt ? new Date(p.expectedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.total > 0 && <Pager total={d.total} page={d.page} per={d.per} />}
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
