import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestInventoryLevelWebhook } from "../lib/sync/catalog.server";
import { queueRefresh } from "../lib/refresh.server";

// inventory_levels/update keeps on-hand quantities current, and re-forecasts the
// variant so days of cover and the stock curve move with it.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const variantId = await ingestInventoryLevelWebhook(shop, payload);
  console.info(`[stocksense] ${shop}: webhook ${topic}${variantId ? "" : " (unknown variant, ignored)"}`);
  if (variantId) queueRefresh(shop, [variantId]);
  return new Response();
};
