import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useRef } from "react";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { coverLabel, money, num, PO_STATUS_TONE, shortId, variantLabel } from "../lib/format";
import { approvePo, cancelPo, poTotal, receivePo, sendPo, updatePoLines } from "../lib/po.server";
import { DownloadButton } from "../components/download";
import { Badge, Btn, Card, Check, Input, List, ListRow, Page, Result, Row, Select, Split, Stack, TextArea } from "../components/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const po = await db.purchaseOrder.findFirst({
    where: { id: params.id, shop: shop.id },
    include: { lines: true, supplier: true },
  });
  if (!po) throw new Response("Not found", { status: 404 });
  const variants = new Map((await db.variant.findMany({ where: { id: { in: po.lines.map((l) => l.variantId) } } })).map((v) => [v.id, v]));
  const forecasts = new Map(
    (await db.forecast.findMany({ where: { shop: shop.id, locationId: "", variantId: { in: po.lines.map((l) => l.variantId) } } })).map((f) => [f.variantId, f]),
  );
  const locations = await db.location.findMany({ where: { shop: shop.id, isActive: true }, orderBy: { name: "asc" } });
  return {
    currency: po.currency,
    po: {
      id: po.id,
      number: po.number,
      status: po.status,
      source: po.source,
      notes: po.notes ?? "",
      locationId: po.locationId,
      expectedAt: po.expectedAt?.toISOString().slice(0, 10) ?? null,
      approvedAt: po.approvedAt?.toISOString() ?? null,
      orderedAt: po.orderedAt?.toISOString() ?? null,
      receivedAt: po.receivedAt?.toISOString() ?? null,
      supplier: { id: po.supplier.id, name: po.supplier.name, email: po.supplier.email },
      total: poTotal(po.lines),
    },
    lines: po.lines.map((l) => {
      const v = variants.get(l.variantId);
      const f = forecasts.get(l.variantId);
      return {
        id: l.id,
        variantId: l.variantId,
        label: v ? variantLabel(v) : l.variantId,
        sku: v?.sku ?? null,
        quantity: l.quantity,
        unitCost: l.unitCost,
        receivedQty: l.receivedQty,
        suggested: f?.suggestedQty ?? null,
        cover: f?.daysOfCover ?? null,
        onHand: f?.onHand ?? null,
      };
    }),
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, admin } = await adminContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = params.id!;
  try {
    if (intent === "save" || intent === "approve") {
      const quantities: Record<string, number> = {};
      for (const [k, v] of form.entries()) if (k.startsWith("qty:")) quantities[k.slice(4)] = Number(v);
      const locationId = String(form.get("locationId") ?? "");
      if (locationId) {
        const location = await db.location.findFirst({ where: { id: locationId, shop: shop.id }, select: { id: true } });
        if (!location) return { error: "That location was not found." };
        await db.purchaseOrder.updateMany({ where: { id, shop: shop.id, status: "DRAFT" }, data: { locationId } });
      }
      const expected = String(form.get("expectedAt") ?? "");
      if (expected) await db.purchaseOrder.updateMany({ where: { id, shop: shop.id }, data: { expectedAt: new Date(`${expected}T12:00:00Z`) } });
      await updatePoLines(shop.id, id, quantities, String(form.get("notes") ?? "") || undefined);
      if (intent === "approve") {
        await approvePo(shop.id, id);
        return { ok: "Approved. Send it to the supplier when you are ready." };
      }
      return { ok: "Saved." };
    }
    if (intent === "send") {
      const { emailed } = await sendPo(shop.id, id, form.get("email") === "on");
      return { ok: emailed ? "Marked as ordered and emailed to the supplier." : "Marked as ordered." };
    }
    if (intent === "receive") {
      const received: Record<string, number> = {};
      for (const [k, v] of form.entries()) if (k.startsWith("rcv:")) received[k.slice(4)] = Number(v);
      const { complete } = await receivePo(admin, shop.id, id, received);
      return { ok: complete ? "All items received. Stock updated in Shopify." : "Partial delivery recorded. Stock updated in Shopify." };
    }
    if (intent === "cancel") {
      await cancelPo(shop.id, id);
      return { ok: "Purchase order cancelled." };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong" };
  }
  return { error: "Unknown action" };
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft, waiting for approval",
  APPROVED: "Approved",
  SENT: "Ordered",
  PARTIAL: "Partly received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

export default function PurchaseOrder() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const po = d.po;
  const fmt = (n: number) => money(n, d.currency);
  const isDraft = po.status === "DRAFT";
  const canReceive = ["APPROVED", "SENT", "PARTIAL"].includes(po.status);
  const intentRef = useRef<HTMLInputElement>(null);
  const setIntent = (v: string) => {
    if (intentRef.current) intentRef.current.value = v;
  };
  const source =
    po.source === "AUTO"
      ? "Written by StockSense from the latest forecast"
      : po.source === "ASK"
        ? "Drafted from Ask StockSense"
        : po.source === "API"
          ? "Created through the API"
          : "Created by your team";

  return (
    <Page
      back={{ href: "/app/purchase-orders", label: "Purchase orders" }}
      eyebrow={source}
      title={po.number}
      accent={po.supplier.name}
      actions={
        <>
          <Badge tone={PO_STATUS_TONE[po.status]}>{STATUS_LABEL[po.status].toLowerCase()}</Badge>
          <DownloadButton href={`/app/purchase-orders/${po.id}/csv`} filename={`${po.number}.csv`}>
            Download CSV
          </DownloadButton>
        </>
      }
    >
      <Result data={result} />

      {isDraft ? (
        <Form method="post">
          <input type="hidden" name="intent" defaultValue="save" ref={intentRef} />
          <Split>
            <Card title="Lines" subtitle="Set a quantity to 0 to remove a line." flush>
              <LinesTable lines={d.lines} fmt={fmt} editable />
            </Card>
            <Stack>
              <Card title="Order summary">
                <Stack tight>
                  <List>
                    <ListRow left={<span className="ss-muted">Lines</span>} right={<span className="ss-mono">{d.lines.length}</span>} />
                    <ListRow left={<span className="ss-muted">Units</span>} right={<span className="ss-mono">{num(d.lines.reduce((a, l) => a + l.quantity, 0))}</span>} />
                    <ListRow left={<span className="ss-muted">Order total</span>} right={<span className="ss-mono ss-strong">{fmt(po.total)}</span>} />
                  </List>
                  <Btn type="submit" variant="primary" block loading={busy} onClick={() => setIntent("approve")}>
                    Review and approve
                  </Btn>
                  <Btn type="submit" block onClick={() => setIntent("save")}>
                    Save draft
                  </Btn>
                </Stack>
              </Card>
              <Card title="Details">
                <Stack tight>
                  <Select label="Deliver to" name="locationId" defaultValue={po.locationId ?? ""}>
                    {d.locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                  <Input label="Expected delivery" type="date" name="expectedAt" defaultValue={po.expectedAt ?? ""} />
                  <TextArea label="Notes for the supplier" name="notes" defaultValue={po.notes} rows={3} />
                </Stack>
              </Card>
            </Stack>
          </Split>
        </Form>
      ) : (
        <Split>
          <Card title="Lines" flush>
            {canReceive ? (
              <Form method="post">
                <input type="hidden" name="intent" value="receive" />
                <LinesTable lines={d.lines} fmt={fmt} receiving />
                <div className="ss-card-foot">
                  <Row between>
                    <span className="ss-muted ss-small">Received units are added to Shopify stock at the delivery location.</span>
                    <Btn type="submit" variant="primary" loading={busy}>
                      Receive stock
                    </Btn>
                  </Row>
                </div>
              </Form>
            ) : (
              <LinesTable lines={d.lines} fmt={fmt} />
            )}
          </Card>
          <Stack>
            <Card title="Order summary">
              <List>
                <ListRow left={<span className="ss-muted">Order total</span>} right={<span className="ss-mono ss-strong">{fmt(po.total)}</span>} />
                {po.expectedAt && <ListRow left={<span className="ss-muted">Expected</span>} right={<span className="ss-mono">{po.expectedAt}</span>} />}
                {po.approvedAt && <ListRow left={<span className="ss-muted">Approved</span>} right={<span className="ss-mono">{po.approvedAt.slice(0, 10)}</span>} />}
                {po.orderedAt && <ListRow left={<span className="ss-muted">Ordered</span>} right={<span className="ss-mono">{po.orderedAt.slice(0, 10)}</span>} />}
                {po.receivedAt && <ListRow left={<span className="ss-muted">Received</span>} right={<span className="ss-mono">{po.receivedAt.slice(0, 10)}</span>} />}
              </List>
            </Card>
            {po.status === "APPROVED" && (
              <Card title="Send to supplier">
                <Form method="post">
                  <input type="hidden" name="intent" value="send" />
                  <Stack tight>
                    <Check
                      name="email"
                      label={po.supplier.email ? `Email the PO to ${po.supplier.email}` : "Email the PO (add a supplier email on the Suppliers page)"}
                      defaultChecked={!!po.supplier.email}
                      disabled={!po.supplier.email}
                    />
                    <Btn type="submit" variant="primary" block loading={busy}>
                      Mark as ordered
                    </Btn>
                  </Stack>
                </Form>
              </Card>
            )}
          </Stack>
        </Split>
      )}

      {!["RECEIVED", "CANCELLED"].includes(po.status) && (
        <Form method="post">
          <input type="hidden" name="intent" value="cancel" />
          <Btn type="submit" variant="danger">
            Cancel purchase order
          </Btn>
        </Form>
      )}
    </Page>
  );
}

function LinesTable({
  lines,
  fmt,
  editable,
  receiving,
}: {
  lines: { id: string; variantId: string; label: string; sku: string | null; quantity: number; unitCost: number; receivedQty: number; suggested: number | null; cover: number | null; onHand: number | null }[];
  fmt: (n: number) => string;
  editable?: boolean;
  receiving?: boolean;
}) {
  return (
    <div className="ss-table-wrap">
      <table className="ss-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">On hand</th>
            <th className="num">Cover</th>
            <th className="num">Suggested</th>
            <th className="num">Qty</th>
            <th className="num">Unit cost</th>
            <th className="num">Line total</th>
            {(receiving || !editable) && <th className="num">{receiving ? "Receive now" : "Received"}</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>
                <div className="ss-item">
                  <Link to={`/app/forecasts/${shortId(l.variantId)}`}>{l.label}</Link>
                  <span className="ss-sku">{l.sku ?? "no sku"}</span>
                </div>
              </td>
              <td className="num">{l.onHand !== null ? num(l.onHand) : "-"}</td>
              <td className="num">{l.cover !== null ? coverLabel(l.cover) : "-"}</td>
              <td className="num">{l.suggested ? num(l.suggested) : "-"}</td>
              <td className="num">
                {editable ? (
                  <input className="ss-input num" type="number" min={0} name={`qty:${l.id}`} defaultValue={String(l.quantity)} aria-label={`Quantity for ${l.label}`} />
                ) : (
                  num(l.quantity)
                )}
              </td>
              <td className="num">{fmt(l.unitCost)}</td>
              <td className="num">{fmt(l.unitCost * l.quantity)}</td>
              {receiving ? (
                <td className="num">
                  <input
                    className="ss-input num"
                    type="number"
                    min={0}
                    name={`rcv:${l.id}`}
                    defaultValue={String(Math.max(0, l.quantity - l.receivedQty))}
                    aria-label={`Received now for ${l.label}`}
                    title={l.receivedQty ? `${l.receivedQty} already in` : undefined}
                  />
                </td>
              ) : (
                !editable && <td className="num">{num(l.receivedQty)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
