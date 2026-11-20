// Order history: two years of orders are imported in the background with a bulk
// operation and rolled up into units sold per variant, location and day.
// New orders arrive by webhook and are added the same day.

import db from "../../db.server";
import { addDays, dayInTimezone, todayIn } from "../dates";
import { gql, type AdminClient } from "../shopify/admin.server";
import { runBulkQuery } from "../shopify/bulk.server";

export const HISTORY_DAYS = 730;

export function ordersBulkQuery(sinceDay: string) {
  return `
{
  orders(query: "created_at:>=${sinceDay}", sortKey: CREATED_AT) {
    edges {
      node {
        id
        createdAt
        cancelledAt
        test
        retailLocation { id }
        fulfillments { location { id } }
        lineItems {
          edges {
            node {
              quantity
              currentQuantity
              variant { id }
              discountedTotalSet { shopMoney { amount } }
              totalDiscountSet { shopMoney { amount } }
            }
          }
        }
      }
    }
  }
}`;
}

type Bucket = { units: number; revenue: number; discountUnits: number };

function bucketKey(variantId: string, locationId: string, date: string) {
  return `${variantId}|${locationId}|${date}`;
}

export async function syncOrderHistory(
  admin: AdminClient,
  shop: string,
  onProgress?: (n: number) => void,
  days = HISTORY_DAYS,
) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const tz = shopRow.timezone;
  const since = addDays(todayIn(tz), -days);
  let rows: AsyncGenerator<Record<string, any>>;
  try {
    rows = await runBulkQuery(admin, ordersBulkQuery(since), (_s, n) => onProgress?.(n));
  } catch (err) {
    // A bulk operation can fail on Shopify's side. Page through the orders instead;
    // if Shopify is refusing access to orders, this surfaces the real reason.
    console.warn(`[stocksense] ${shop}: order bulk import failed (${describeError(err)}), reading orders page by page`);
    const paged = await syncRecentOrders(admin, shop, days + 1, onProgress);
    await refreshFirstSold(shop);
    return { orders: paged.orders, buckets: paged.touched.length };
  }

  const orders = new Map<string, { date: string; location: string; cancelled: boolean }>();
  const buckets = new Map<string, Bucket>();
  const recentOrderIds: string[] = [];
  const recentCutoff = addDays(todayIn(tz), -7);

  for await (const obj of rows) {
    if (obj.id?.startsWith("gid://shopify/Order/")) {
      const date = dayInTimezone(new Date(obj.createdAt), tz);
      const location = obj.retailLocation?.id ?? obj.fulfillments?.find((f: any) => f.location?.id)?.location?.id ?? "";
      orders.set(obj.id, { date, location, cancelled: !!obj.cancelledAt || (!!obj.test && !shopRow.isDevStore) });
      if (date >= recentCutoff) recentOrderIds.push(obj.id);
    } else if (obj.__parentId && "quantity" in obj) {
      const order = orders.get(obj.__parentId);
      const variantId = obj.variant?.id;
      if (!order || order.cancelled || !variantId) continue;
      const units = Number(obj.currentQuantity ?? obj.quantity ?? 0); // net of removals and refunds
      if (units <= 0) continue;
      const revenue = Number(obj.discountedTotalSet?.shopMoney?.amount ?? 0);
      const discounted = Number(obj.totalDiscountSet?.shopMoney?.amount ?? 0) > 0;
      const key = bucketKey(variantId, order.location, order.date);
      const b = buckets.get(key) ?? { units: 0, revenue: 0, discountUnits: 0 };
      b.units += units;
      b.revenue += revenue;
      if (discounted) b.discountUnits += units;
      buckets.set(key, b);
    }
  }

  // Replace the imported window. Re-running the import is idempotent.
  await db.salesDaily.deleteMany({ where: { shop, date: { gte: since } } });
  const data = [...buckets.entries()].map(([key, b]) => {
    const [variantId, locationId, date] = key.split("|");
    return { shop, variantId, locationId, date, ...b };
  });
  for (let i = 0; i < data.length; i += 1000) {
    await db.salesDaily.createMany({ data: data.slice(i, i + 1000) });
  }
  for (const id of recentOrderIds) {
    await db.processedOrder.upsert({ where: { id }, create: { id, shop }, update: {} });
  }
  await refreshFirstSold(shop);
  return { orders: orders.size, buckets: data.length };
}

async function refreshFirstSold(shop: string) {
  const firsts = await db.salesDaily.groupBy({ by: ["variantId"], where: { shop }, _min: { date: true } });
  for (let i = 0; i < firsts.length; i += 200) {
    await db.$transaction(
      firsts.slice(i, i + 200).map((f) =>
        db.variant.updateMany({
          where: { id: f.variantId },
          data: { firstSoldAt: f._min.date ? new Date(`${f._min.date}T00:00:00Z`) : null },
        }),
      ),
    );
  }
}

/**
 * orders/create webhook (REST payload). Returns the variant ids touched so velocity
 * checks can run the same day.
 */
export async function ingestOrderWebhook(shop: string, order: any): Promise<string[]> {
  const orderId = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;
  if (order.cancelled_at) return [];
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  // Test orders are ignored, except on development stores where every order is a test order.
  if (order.test && !shopRow?.isDevStore) return [];
  const already = await db.processedOrder.findUnique({ where: { id: orderId } });
  if (already) return [];

  const tz = shopRow?.timezone ?? "UTC";
  const date = dayInTimezone(new Date(order.created_at ?? Date.now()), tz);
  const locationId = order.location_id ? `gid://shopify/Location/${order.location_id}` : "";

  const touched: string[] = [];
  const ops = [];
  for (const li of order.line_items ?? []) {
    if (!li.variant_id) continue;
    const variantId = `gid://shopify/ProductVariant/${li.variant_id}`;
    const units = Number(li.quantity ?? 0);
    if (units <= 0) continue;
    const discount = Math.max(Number(li.total_discount ?? 0), sumAllocations(li.discount_allocations));
    const revenue = Number(li.price ?? 0) * units - discount;
    touched.push(variantId);
    ops.push(
      db.salesDaily.upsert({
        where: { variantId_locationId_date: { variantId, locationId, date } },
        create: { shop, variantId, locationId, date, units, revenue, discountUnits: discount > 0 ? units : 0 },
        update: {
          units: { increment: units },
          revenue: { increment: revenue },
          discountUnits: { increment: discount > 0 ? units : 0 },
        },
      }),
    );
  }
  ops.push(db.processedOrder.create({ data: { id: orderId, shop } }));
  await db.$transaction(ops);
  return touched;
}

/** orders/cancelled webhook: take the units back out of the day they were sold. */
export async function reverseOrderWebhook(shop: string, order: any) {
  const orderId = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;
  const processed = await db.processedOrder.findUnique({ where: { id: orderId } });
  const reversedKey = `${orderId}:cancelled`;
  if (!processed) return;
  if (await db.processedOrder.findUnique({ where: { id: reversedKey } })) return;
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  const date = dayInTimezone(new Date(order.created_at), shopRow?.timezone ?? "UTC");
  const locationId = order.location_id ? `gid://shopify/Location/${order.location_id}` : "";
  const ops = [];
  for (const li of order.line_items ?? []) {
    if (!li.variant_id) continue;
    const variantId = `gid://shopify/ProductVariant/${li.variant_id}`;
    const units = Number(li.quantity ?? 0);
    ops.push(
      db.salesDaily.updateMany({
        where: { variantId, locationId, date },
        data: { units: { decrement: units }, revenue: { decrement: Number(li.price ?? 0) * units } },
      }),
    );
  }
  ops.push(db.processedOrder.create({ data: { id: reversedKey, shop } }));
  await db.$transaction(ops);
}

function sumAllocations(allocs: any[] | undefined) {
  return (allocs ?? []).reduce((s, a) => s + Number(a.amount ?? 0), 0);
}

const RECENT_ORDERS = `#graphql
  query StockSenseRecentOrders($q: String!, $after: String) {
    orders(first: 20, after: $after, query: $q, sortKey: CREATED_AT) {
      nodes {
        id
        createdAt
        cancelledAt
        test
        retailLocation { id }
        fulfillments(first: 3) { location { id } }
        lineItems(first: 40) {
          nodes {
            quantity
            currentQuantity
            variant { id }
            discountedTotalSet { shopMoney { amount } }
            totalDiscountSet { shopMoney { amount } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/**
 * Re-read the last few days of orders straight from Shopify and replace those days
 * of sales. Runs on every rebuild, so sales stay right even when order webhooks are
 * not delivered (for example before protected customer data access is set up).
 */
export async function syncRecentOrders(admin: AdminClient, shop: string, days = 3, onProgress?: (n: number) => void) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const tz = shopRow.timezone;
  const since = addDays(todayIn(tz), -days + 1);
  // Ask Shopify for a day extra so orders near midnight in the shop timezone are included.
  const q = `created_at:>=${addDays(since, -1)}`;
  const buckets = new Map<string, Bucket>();
  const ids: string[] = [];
  let after: string | null = null;
  let orders = 0;
  do {
    const data: any = await withRetry(() => gql(admin, RECENT_ORDERS, { q, after }));
    for (const o of data.orders.nodes) {
      const date = dayInTimezone(new Date(o.createdAt), tz);
      if (date < since) continue;
      ids.push(o.id);
      orders++;
      if (o.cancelledAt || (o.test && !shopRow.isDevStore)) continue;
      const location = o.retailLocation?.id ?? o.fulfillments?.find((f: any) => f.location?.id)?.location?.id ?? "";
      for (const li of o.lineItems.nodes) {
        const variantId = li.variant?.id;
        const units = Number(li.currentQuantity ?? li.quantity ?? 0);
        if (!variantId || units <= 0) continue;
        const key = bucketKey(variantId, location, date);
        const b = buckets.get(key) ?? { units: 0, revenue: 0, discountUnits: 0 };
        b.units += units;
        b.revenue += Number(li.discountedTotalSet?.shopMoney?.amount ?? 0);
        if (Number(li.totalDiscountSet?.shopMoney?.amount ?? 0) > 0) b.discountUnits += units;
        buckets.set(key, b);
      }
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    onProgress?.(orders);
  } while (after);

  const rows = [...buckets.entries()].map(([key, b]) => {
    const [variantId, locationId, date] = key.split("|");
    return { shop, variantId, locationId, date, ...b };
  });
  await db.$transaction([
    // Demo variants (development stores) have no real orders: leave their sales alone.
    db.salesDaily.deleteMany({ where: { shop, date: { gte: since }, NOT: { variantId: { contains: "/demo-" } } } }),
    ...(rows.length ? [db.salesDaily.createMany({ data: rows })] : []),
  ]);
  // Mark them processed so a late webhook for the same order is not counted twice.
  for (const id of ids) await db.processedOrder.upsert({ where: { id }, create: { id, shop }, update: {} });
  return { orders, touched: [...new Set(rows.map((r) => r.variantId))] };
}

/** A short, readable reason from a Shopify error, for logs and the import banner. */
export function describeError(err: unknown): string {
  const e = err as { message?: string; details?: unknown };
  const details = e?.details;
  if (typeof details === "string" && details) return `${e.message} (${details})`;
  if (Array.isArray(details) && details.length) {
    const first = details[0] as { message?: string };
    if (first?.message) return `${e.message}: ${first.message}`;
  }
  return e?.message ?? String(err);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const throttled = JSON.stringify((err as any)?.details ?? "").includes("THROTTLED");
      if (!throttled || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}
