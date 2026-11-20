import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useLocation, useRouteError } from "react-router";
import { AskLauncher } from "../components/ask-panel";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { adminContext } from "../lib/context.server";
import { hasFeature } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  // Choose a plan first (14-day free trial). Billing itself stays reachable.
  if (shop.plan === "NONE" && !url.pathname.startsWith("/app/billing")) {
    throw redirect(`/app/billing${url.search}`);
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    nav: {
      transfers: hasFeature(shop.plan, "transfers"),
    },
  };
};

export default function App() {
  const { apiKey, nav } = useLoaderData<typeof loader>();
  const onAskPage = useLocation().pathname.startsWith("/app/ask");

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/forecasts">Forecasts</s-link>
        <s-link href="/app/alerts">Alerts</s-link>
        <s-link href="/app/purchase-orders">Purchase orders</s-link>
        <s-link href="/app/suppliers">Suppliers</s-link>
        {nav.transfers && <s-link href="/app/transfers">Transfers</s-link>}
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/billing">Plan</s-link>
      </s-app-nav>
      <Outlet />
      {!onAskPage && <AskLauncher />}
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
