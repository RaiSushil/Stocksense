import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ingestOrderWebhook, reverseOrderWebhook } from "../lib/sync/orders.server";
import { queueRefresh } from "../lib/refresh.server";

// orders/create and orders/cancelled. Sales land in today's totals right away, and
// the affected variants are re-forecast within seconds (which also runs the
// same-day velocity check).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  if (!shopRow || shopRow.uninstalledAt) return new Response();
  const variantIds = ((payload as any).line_items ?? [])
    .filter((li: any) => li.variant_id)
    .map((li: any) => `gid://shopify/ProductVariant/${li.variant_id}`);
  console.info(`[stocksense] ${shop}: webhook ${topic} (${variantIds.length} line items)`);

  if (topic === "ORDERS_CANCELLED") {
    await reverseOrderWebhook(shop, payload);
    queueRefresh(shop, variantIds);
    return new Response();
  }
  const touched = await ingestOrderWebhook(shop, payload);
  queueRefresh(shop, touched);
  return new Response();
};
