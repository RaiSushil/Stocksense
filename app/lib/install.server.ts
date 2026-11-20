import type { Shop } from "@prisma/client";
import db from "../db.server";
import { inBackground, runFullSync, startScheduler } from "./jobs.server";
import type { AdminClient } from "./shopify/admin.server";
import { syncShopInfo } from "./sync/catalog.server";

/**
 * Called after OAuth / token exchange. Creates the shop row and starts the
 * background import the first time (about five minutes for most catalogs; order
 * history keeps importing in the background).
 */
export async function onInstalled(shop: string, admin: AdminClient) {
  startScheduler();
  try {
    await upsertShop(shop);
    await db.shop.update({ where: { id: shop }, data: { uninstalledAt: null } });
    await syncShopInfo(admin, shop);
  } catch (err) {
    console.error("[stocksense] install setup failed, the import will still start on the next page load", err);
  }
  const row = await db.shop.findUnique({ where: { id: shop } });
  if (row) maybeStartImport(row);
}

/** Make sure a shop row exists, and that its first import is running. Called on every admin page load. */
export async function ensureShop(shop: string) {
  startScheduler();
  const row = await upsertShop(shop);
  maybeStartImport(row);
  return row;
}

// The app page and the install hook can both arrive first; upsert avoids the race.
async function upsertShop(shop: string) {
  try {
    return await db.shop.upsert({ where: { id: shop }, create: { id: shop }, update: {} });
  } catch {
    return db.shop.findUniqueOrThrow({ where: { id: shop } });
  }
}

const RETRY_AFTER_ERROR_MS = 10 * 60_000;

/**
 * Start the import if it never ran, if a restart killed it half way, or if it
 * failed (retried every 10 minutes until one finishes, hourly after that).
 */
export function maybeStartImport(row: Shop) {
  if (row.uninstalledAt) return;
  const now = Date.now();
  const lockFree = !row.jobLockedUntil || row.jobLockedUntil.getTime() < now;
  if (!lockFree) return;
  const neverStarted = row.syncStatus === "PENDING";
  const interrupted = row.syncStatus === "RUNNING";
  // A failed import is retried: every 10 minutes before any import has finished, hourly after.
  const wait = row.lastFullSyncAt ? 6 * RETRY_AFTER_ERROR_MS : RETRY_AFTER_ERROR_MS;
  const failed = row.syncStatus === "ERROR" && now - row.updatedAt.getTime() > wait;
  if (neverStarted || interrupted || failed) {
    console.info(`[stocksense] starting import for ${row.id} (${row.syncStatus.toLowerCase()})`);
    inBackground("full-sync", runFullSync(row.id));
  }
}
