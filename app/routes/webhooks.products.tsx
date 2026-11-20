import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteProductWebhook, ingestProductWebhook } from "../lib/sync/catalog.server";

// products/create, products/update and products/delete.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (topic === "PRODUCTS_DELETE") await deleteProductWebhook(shop, payload);
  else await ingestProductWebhook(shop, payload);
  return new Response();
};
