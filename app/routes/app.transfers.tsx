import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext } from "../lib/context.server";
import { coverLabel, money, num, shortId } from "../lib/format";
import { hasFeature } from "../lib/plans";
import { createTransfer, transferSuggestions } from "../lib/transfers.server";
import { Btn, Card, Empty, Page, Result, Row, UpgradeNotice } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const allowed = hasFeature(shop.plan, "transfers");
  return { allowed, currency: shop.currency, suggestions: allowed ? await transferSuggestions(shop.id) : [] };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await adminContext(request);
  if (!hasFeature(shop.plan, "transfers")) return { error: "Transfers are on the Pro plan." };
  const form = await request.formData();
  const [from, to] = String(form.get("route")).split("|");
  const lines = form
    .getAll("line")
    .map((v) => String(v).split("|"))
    .map(([variantId, qty]) => ({ variantId, quantity: Number(qty) }));
  try {
    const t = await createTransfer(admin, shop.id, from, to, lines);
    return { ok: `Draft transfer ${t.name} created in Shopify. Ship it from Products > Transfers.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create the transfer" };
  }
};

export default function Transfers() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();

  if (!d.allowed) {
    return (
      <Page eyebrow="Multi-location" title="Transfer" accent="suggestions">
        <UpgradeNotice feature="transfers">
          Move surplus from a location with too much cover to one about to run short, before paying for a new purchase order.
        </UpgradeNotice>
      </Page>
    );
  }

  // Group suggestions by origin and destination so each group becomes one transfer.
  const groups = new Map<string, typeof d.suggestions>();
  for (const s of d.suggestions) {
    const key = `${s.fromLocationId}|${s.toLocationId}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  return (
    <Page
      eyebrow="Multi-location"
      title="Transfer"
      accent="suggestions"
      subtitle="Based on per-location forecasts. Each group becomes one draft transfer in Shopify."
    >
      <Result data={result} />
      {groups.size === 0 && (
        <Card>
          <Empty heading="No transfers needed">Every location either has enough cover or there is no surplus elsewhere to move.</Empty>
        </Card>
      )}
      {[...groups.entries()].map(([key, items]) => (
        <Card key={key} title={`${items[0].fromName} → ${items[0].toName}`} meta={`${items.length} variants`} flush>
          <Form method="post">
            <input type="hidden" name="route" value={key} />
            {items.map((s) => (
              <input key={s.variantId} type="hidden" name="line" value={`${s.variantId}|${s.quantity}`} />
            ))}
            <div className="ss-table-wrap">
              <table className="ss-table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="num">Move</th>
                    <th className="num">Cover at destination</th>
                    <th className="num">Cover at origin</th>
                    <th className="num">At risk</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((s) => (
                    <tr key={s.variantId}>
                      <td>
                        <div className="ss-item">
                          <Link to={`/app/forecasts/${shortId(s.variantId)}`}>{s.label}</Link>
                          {s.sku && <span className="ss-sku">{s.sku}</span>}
                        </div>
                      </td>
                      <td className="num ss-accent">{num(s.quantity)}</td>
                      <td className="num">{coverLabel(s.toCover)}</td>
                      <td className="num">{coverLabel(s.fromCover)}</td>
                      <td className="num">{money(s.revenueAtRisk, d.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ss-card-foot">
              <Row end>
                <Btn type="submit" variant="primary" loading={nav.state !== "idle"}>
                  Create draft transfer
                </Btn>
              </Row>
            </div>
          </Form>
        </Card>
      ))}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
