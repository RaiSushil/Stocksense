import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "./install.server";
import { hasFeature, type Feature } from "./plans";
import type { AdminClient } from "./shopify/admin.server";

/** Authenticate an admin request and load the shop row. */
export async function adminContext(request: Request) {
  const { admin, session, billing } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  // Local development without Billing: STOCKSENSE_DEV_PLAN=PRO npm run dev
  const devPlan = process.env.STOCKSENSE_DEV_PLAN;
  const plan = devPlan && process.env.NODE_ENV !== "production" ? devPlan : shop.plan;
  return { admin: admin as unknown as AdminClient, session, billing, shop: { ...shop, plan } };
}

export async function requireFeature(request: Request, feature: Feature) {
  const ctx = await adminContext(request);
  return { ...ctx, allowed: hasFeature(ctx.shop.plan, feature) };
}

export function back(url: string, message?: string, error = false) {
  const u = new URL(url, "http://x");
  if (message) u.searchParams.set(error ? "error" : "ok", message);
  return redirect(`${u.pathname}${u.search}`);
}
