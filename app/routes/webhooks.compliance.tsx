import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../lib/shop-data.server";

// Mandatory privacy webhooks. StockSense stores no customer personal data (only
// units sold per variant per day), so customer requests have nothing to return or
// erase. shop/redact deletes everything held for the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") {
    await deleteShopData(shop);
  }
  return new Response();
};
