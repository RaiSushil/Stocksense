// Job orchestration: first-time import, scheduled rebuilds and the in-process scheduler.
// A row-level lock on Shop prevents two jobs for the same shop running at once,
// including across several app instances sharing one database.

import db from "../db.server";
import { evaluateAlerts } from "./alerts/run.server";
import { rebuildForecasts } from "./forecast/run.server";
import { planDef } from "./plans";
import { syncAutoDrafts } from "./po.server";
import { offlineAdmin, type AdminClient } from "./shopify/admin.server";
import { syncCatalog, syncLocations, syncShopInfo } from "./sync/catalog.server";
import { describeError, syncOrderHistory, syncRecentOrders } from "./sync/orders.server";

const LOCK_MINUTES = 90;

async function withLock<T>(shop: string, fn: () => Promise<T>): Promise<T | null> {
  const now = new Date();
  const got = await db.shop.updateMany({
    where: { id: shop, OR: [{ jobLockedUntil: null }, { jobLockedUntil: { lt: now } }] },
    data: { jobLockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) },
  });
  if (got.count === 0) return null;
  try {
    return await fn();
  } finally {
    await db.shop.update({ where: { id: shop }, data: { jobLockedUntil: null } }).catch(() => {});
  }
}

/** A message the merchant can act on, kept short for the banner. */
export function syncErrorMessage(stageLabel: string, err: unknown) {
  const reason = describeError(err);
  const denied = /ACCESS_DENIED|access denied|not approved to access|protected customer data/i.test(reason);
  if (denied && /order/i.test(stageLabel)) {
    return "Shopify did not allow StockSense to read orders. In the Dev Dashboard open the app, then Settings, Access requests, Protected customer data, and select Customer data. Then retry the import.";
  }
  return `${stageLabel} failed: ${reason}`.slice(0, 400);
}

async function setStage(shop: string, syncStage: string) {
  console.info(`[stocksense] ${shop}: ${syncStage}`);
  await db.shop.update({ where: { id: shop }, data: { syncStage } });
}

/** First install (or "Re-import history"): catalog, two years of orders, forecasts, alerts. */
export async function runFullSync(shop: string, admin?: AdminClient) {
  return withLock(shop, async () => {
    const client = admin ?? (await offlineAdmin(shop));
    await db.shop.update({ where: { id: shop }, data: { syncStatus: "RUNNING", syncError: null } });
    let current = "Reading store settings";
    const stage = async (shopId: string, label: string) => {
      current = label.replace(/ \(\d+ records\)$/, "");
      await setStage(shopId, label);
    };
    try {
      await stage(shop, "Reading store settings");
      await syncShopInfo(client, shop);
      await stage(shop, "Importing locations");
      await syncLocations(client, shop);
      await stage(shop, "Importing products and inventory");
      await syncCatalog(client, shop, (n) => void stage(shop, `Importing products and inventory (${n} records)`));
      await stage(shop, "Importing two years of orders");
      await syncOrderHistory(client, shop, (n) => void stage(shop, `Importing two years of orders (${n} records)`));
      await stage(shop, "Building forecasts");
      await rebuildForecasts(shop);
      await syncAutoDrafts(shop);
      await stage(shop, "Checking alerts");
      await evaluateAlerts(shop);
      await db.shop.update({
        where: { id: shop },
        data: { syncStatus: "READY", syncStage: null, lastFullSyncAt: new Date() },
      });
      console.info(`[stocksense] ${shop}: import finished`);
      return true;
    } catch (err) {
      console.error(`[stocksense] full sync failed for ${shop}`, err);
      await db.shop.update({
        where: { id: shop },
        data: { syncStatus: "ERROR", syncError: syncErrorMessage(current, err) },
      });
      return false;
    }
  });
}

/** Scheduled rebuild: refresh inventory, re-forecast, refresh drafts and alerts. */
export async function runRebuild(shop: string, opts: { refreshCatalog?: boolean; admin?: AdminClient } = {}) {
  return withLock(shop, async () => {
    try {
      if (opts.refreshCatalog !== false) {
        const client = opts.admin ?? (await offlineAdmin(shop));
        await syncShopInfo(client, shop);
        await syncLocations(client, shop);
        await syncCatalog(client, shop);
        const recent = await syncRecentOrders(client, shop);
        console.info(`[stocksense] ${shop}: synced ${recent.orders} orders from the last 3 days`);
      }
      const summary = await rebuildForecasts(shop);
      await syncAutoDrafts(shop);
      await evaluateAlerts(shop);
      return summary;
    } catch (err) {
      console.error(`[stocksense] rebuild failed for ${shop}`, err);
      return null;
    }
  });
}

/** Refresh only some variants' forecasts, then drafts and alerts. Returns false if another job holds the lock. */
export async function runPartialRefresh(shop: string, variantIds: string[]) {
  const res = await withLock(shop, async () => {
    await rebuildForecasts(shop, { variantIds });
    await syncAutoDrafts(shop);
    await evaluateAlerts(shop);
    return true;
  });
  return res !== null;
}

/** Run a job without blocking the request that triggered it. */
export function inBackground(label: string, p: Promise<unknown>) {
  p.catch((err) => console.error(`[stocksense] background job ${label} failed`, err));
}

let started = false;

/**
 * In-process scheduler. Checks every 5 minutes which shops are due for a rebuild
 * (weekly, nightly or hourly by plan). For multi-instance deployments set
 * DISABLE_SCHEDULER=true on all but one instance, or call /jobs/tick from cron.
 */
export function startScheduler() {
  if (started || process.env.DISABLE_SCHEDULER === "true" || process.env.NODE_ENV === "test") return;
  started = true;
  // Single-instance mode: any job lock left behind by a previous process (for
  // example a dev server restart mid-import) is stale, so release it.
  inBackground(
    "release-locks",
    db.shop.updateMany({ where: { jobLockedUntil: { not: null } }, data: { jobLockedUntil: null } }),
  );
  const tick = () => inBackground("tick", schedulerTick());
  setTimeout(tick, 30_000);
  setInterval(tick, 5 * 60_000).unref();
}

export async function schedulerTick() {
  const shops = await db.shop.findMany({
    where: { uninstalledAt: null, plan: { not: "NONE" }, syncStatus: { in: ["READY", "ERROR"] } },
  });
  const now = Date.now();
  for (const s of shops) {
    const plan = planDef(s.plan);
    if (!plan) continue;
    const due = !s.lastForecastAt || now - s.lastForecastAt.getTime() >= plan.rebuildEveryHours * 3_600_000 - 5 * 60_000;
    if (!due) continue;
    // A failed import is retried on the schedule too, so the banner clears once it works.
    // Each store runs on its own: one store's failure never holds up the others.
    try {
      if (s.syncStatus === "ERROR") await runFullSync(s.id);
      else await runRebuild(s.id);
    } catch (err) {
      console.error(`[stocksense] ${s.id}: scheduled job failed`, err);
    }
  }
  // Reset Ask quotas monthly.
  const monthAgo = new Date(now - 30 * 86_400_000);
  await db.shop.updateMany({
    where: { askPeriodStart: { lt: monthAgo } },
    data: { askPeriodStart: new Date(), askQuestionsUsed: 0 },
  });
}
