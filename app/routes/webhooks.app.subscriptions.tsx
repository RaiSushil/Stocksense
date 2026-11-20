import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseBillingKey } from "../lib/plans";

// app_subscriptions/update: keep the stored plan in step with Shopify Billing
// (approved, cancelled, frozen, expired).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const sub = (payload as any).app_subscription ?? {};
  const parsed = parseBillingKey(String(sub.name ?? ""));
  const status = String(sub.status ?? "").toUpperCase();
  if (status === "ACTIVE" && parsed) {
    await db.shop.updateMany({ where: { id: shop }, data: { plan: parsed.plan, billingInterval: parsed.interval } });
  } else if (["CANCELLED", "DECLINED", "EXPIRED", "FROZEN"].includes(status)) {
    const current = await db.shop.findUnique({ where: { id: shop } });
    // Only drop the plan if the subscription that ended is the one we have on file.
    if (current && parsed && current.plan === parsed.plan) {
      await db.shop.update({ where: { id: shop }, data: { plan: "NONE", billingInterval: null } });
    }
  }
  return new Response();
};
