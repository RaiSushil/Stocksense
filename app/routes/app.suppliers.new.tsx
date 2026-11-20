import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext } from "../lib/context.server";
import { readSupplierForm, saveSupplier, validateSupplier, vendorOptions, categoryOptions } from "../lib/supplier-form.server";
import { inBackground, runRebuild } from "../lib/jobs.server";
import { SupplierForm } from "../components/supplier-form";
import { CURRENCIES, PAYMENT_TERMS } from "../lib/supplier-options";
import { Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  return {
    shopCurrency: shop.currency,
    defaultLead: shop.defaultLeadTimeDays,
    vendors: await vendorOptions(shop.id),
    categories: await categoryOptions(shop.id),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const values = readSupplierForm(await request.formData());
  const errors = await validateSupplier(shop.id, values);
  if (Object.keys(errors).length) return { values, errors };
  await saveSupplier(shop.id, values);
  inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
  throw redirect(`/app/suppliers?saved=${encodeURIComponent(values.name)}`);
};

export default function NewSupplier() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const values = result?.values ?? {
    name: "",
    email: "",
    contactName: "",
    phone: "",
    website: "",
    address: "",
    currency: d.shopCurrency,
    paymentTerms: "",
    leadTime: String(d.defaultLead),
    minOrderValue: "0",
    notes: "",
    vendors: [],
    categories: [],
  };
  return (
    <Page back={{ href: "/app/suppliers", label: "Suppliers" }} eyebrow="Supply" title="Add a" accent="supplier" subtitle="Details used on purchase orders and in every forecast for the products you assign.">
      <SupplierForm
        key={JSON.stringify(result?.errors ?? {})}
        values={values}
        errors={result?.errors ?? {}}
        vendors={d.vendors}
        categories={d.categories}
        currencies={CURRENCIES}
        paymentTerms={PAYMENT_TERMS}
        shopCurrency={d.shopCurrency}
        busy={nav.state !== "idle"}
        mode="create"
      />
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
