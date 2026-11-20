import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminContext } from "../lib/context.server";
import { AskPanel } from "../components/ask-panel";
import { Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await adminContext(request);
  return null;
};

// Full-page view of Ask StockSense. The same conversations are available from the
// floating button on every page.
export default function Ask() {
  const [params] = useSearchParams();
  const thread = params.get("thread");
  // Opening a specific conversation from the drawer: make it the active one.
  if (typeof window !== "undefined" && thread) {
    try {
      window.localStorage.setItem("stocksense-ask-thread", thread);
    } catch {
      // ignore
    }
  }
  return (
    <Page eyebrow="Ask your inventory" title="Ask your inventory" accent="anything" subtitle="Plain English in, real numbers and charts out. Every conversation is saved.">
      <AskPanel key={thread ?? "last"} mode="page" />
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
