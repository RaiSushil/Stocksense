import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import {
  readSupplierForm,
  saveSupplier,
  supplierToValues,
  validateSupplier,
  vendorOptions,
  categoryOptions,
} from "../lib/supplier-form.server";
import { inBackground, runRebuild } from "../lib/jobs.server";
import { leadTimeStats } from "../lib/suppliers.server";
import { SupplierForm } from "../components/supplier-form";
import { CURRENCIES, PAYMENT_TERMS } from "../lib/supplier-options";
import { Btn, Card, List, ListRow, Page } from "../components/ui";
import { num } from "../lib/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const s = await db.supplier.findFirst({
    where: { id: params.id, shop: shop.id },
    include: { leadTimes: { orderBy: { observedAt: "desc" }, take: 8 } },
  });
  if (!s) throw new Response("Not found", { status: 404 });
  const stats = (await leadTimeStats(shop.id)).get(s.id);
  const [skus, openPos] = await Promise.all([
    db.variant.count({ where: { shop: shop.id, supplierId: s.id } }),
    db.purchaseOrder.count({ where: { shop: shop.id, supplierId: s.id, status: { in: ["DRAFT", "APPROVED", "SENT", "PARTIAL"] } } }),
  ]);
  return {
    id: s.id,
    shopCurrency: shop.currency,
    values: supplierToValues(s),
    vendors: await vendorOptions(shop.id),
    categories: await categoryOptions(shop.id),
    skus,
    openPos,
    effectiveLead: stats?.effective ?? s.defaultLeadTimeDays,
    history: s.leadTimes.map((o) => ({ days: o.days, source: o.source, at: o.observedAt.toISOString().slice(0, 10) })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const form = await request.formData();
  const s = await db.supplier.findFirst({ where: { id: params.id, shop: shop.id } });
  if (!s) throw new Response("Not found", { status: 404 });
  if (form.get("intent") === "delete") {
    const pos = await db.purchaseOrder.count({ where: { shop: shop.id, supplierId: s.id } });
    if (pos) return { deleteError: "This supplier has purchase orders, so it can't be deleted.", values: undefined, errors: {} };
    await db.supplier.delete({ where: { id: s.id } });
    throw redirect(`/app/suppliers?deleted=${encodeURIComponent(s.name)}`);
  }
  const values = readSupplierForm(form);
  const errors = await validateSupplier(shop.id, values, s.id);
  if (Object.keys(errors).length) return { values, errors, deleteError: undefined };
  await saveSupplier(shop.id, values, s.id);
  inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
  throw redirect(`/app/suppliers?saved=${encodeURIComponent(values.name)}`);
};

export default function EditSupplier() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  return (
    <Page back={{ href: "/app/suppliers", label: "Suppliers" }} eyebrow="Supply" title={d.values.name} subtitle={`${num(d.skus)} SKUs assigned · ${d.openPos} open purchase orders`}>
      <SupplierForm
        key={JSON.stringify(result?.errors ?? {})}
        values={result?.values ?? d.values}
        errors={result?.errors ?? {}}
        vendors={d.vendors}
        categories={d.categories}
        currencies={CURRENCIES}
        paymentTerms={PAYMENT_TERMS}
        shopCurrency={d.shopCurrency}
        busy={nav.state !== "idle"}
        mode="edit"
        side={
          <>
            <Card title="Lead time history" subtitle={`Forecasts use ${Math.round(d.effectiveLead)} days now.`}>
              {d.history.length ? (
                <List>
                  {d.history.map((h, i) => (
                    <ListRow
                      key={i}
                      left={<span className="ss-sku">{`${h.at} · ${h.source === "PO_RECEIVED" ? "received PO" : "manual"}`}</span>}
                      right={<span className="ss-mono">{h.days} d</span>}
                    />
                  ))}
                </List>
              ) : (
                <span className="ss-muted ss-small">No deliveries recorded yet. Receiving purchase orders builds a real average.</span>
              )}
            </Card>
          </>
        }
      />
      <Card title="Danger zone">
        <Form method="post">
          <input type="hidden" name="intent" value="delete" />
          <div className="ss-row between">
            <span className="ss-muted ss-small">{result?.deleteError ?? "Deleting removes the supplier. Its products become unassigned."}</span>
            <Btn type="submit" variant="danger">
              Delete supplier
            </Btn>
          </div>
        </Form>
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
