import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);

  // Webhooks can fire more than once and after the session is already gone.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  // Keep the data for 48 hours in case of a reinstall; shop/redact deletes it.
  await db.shop.updateMany({
    where: { id: shop },
    data: { uninstalledAt: new Date(), plan: "NONE", billingInterval: null, jobLockedUntil: null },
  });
  return new Response();
};
