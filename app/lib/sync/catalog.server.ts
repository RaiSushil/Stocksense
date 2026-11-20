// Catalog and inventory import: locations, variants (with cost) and inventory levels
// per location. Suppliers are created from product vendors so the merchant does not
// have to set anything up before the first forecast.

import db from "../../db.server";
import { gql, type AdminClient } from "../shopify/admin.server";
import { runBulkQuery } from "../shopify/bulk.server";

export const SHOP_QUERY = `#graphql
  query StockSenseShop {
    shop { name email ianaTimezone currencyCode plan { partnerDevelopment } }
  }`;

export async function syncShopInfo(admin: AdminClient, shop: string) {
  const data = await gql<any>(admin, SHOP_QUERY);
  const s = data.shop;
  // Development stores only take test payments, so their test orders are the real sales.
  const isDevStore = !!s.plan?.partnerDevelopment;
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop, name: s.name, email: s.email, alertEmail: s.email, timezone: s.ianaTimezone, currency: s.currencyCode, isDevStore },
    update: { name: s.name, email: s.email, timezone: s.ianaTimezone, currency: s.currencyCode, isDevStore, uninstalledAt: null },
  });
}

const LOCATIONS_QUERY = `#graphql
  query StockSenseLocations($after: String) {
    locations(first: 250, after: $after, includeInactive: true) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export async function syncLocations(admin: AdminClient, shop: string) {
  let after: string | null = null;
  const seen: string[] = [];
  do {
    const data: any = await gql(admin, LOCATIONS_QUERY, { after });
    for (const loc of data.locations.nodes) {
      seen.push(loc.id);
      await db.location.upsert({
        where: { id: loc.id },
        create: { id: loc.id, shop, name: loc.name, isActive: loc.isActive },
        update: { name: loc.name, isActive: loc.isActive },
      });
    }
    after = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
  } while (after);
  await db.location.updateMany({ where: { shop, id: { notIn: seen } }, data: { isActive: false } });
}

export const CATALOG_BULK_QUERY = `
{
  productVariants(query: "product_status:active,draft") {
    edges {
      node {
        id
        title
        sku
        price
        product {
          id
          title
          vendor
          productType
          category { name }
          status
          featuredMedia { preview { image { url } } }
        }
        inventoryItem {
          id
          tracked
          unitCost { amount }
          inventoryLevels {
            edges {
              node {
                location { id }
                quantities(names: ["available", "on_hand", "incoming"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
}`;

interface VariantRow {
  id: string;
  productId: string;
  inventoryItemId: string | null;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  vendor: string | null;
  productType: string | null;
  imageUrl: string | null;
  price: number;
  unitCost: number | null;
  status: string;
  tracked: boolean;
}

const CATALOG_PAGE = `#graphql
  query StockSenseCatalogPage($after: String) {
    productVariants(first: 25, after: $after, query: "product_status:active,draft") {
      nodes {
        id
        title
        sku
        price
        product {
          id
          title
          vendor
          productType
          category { name }
          status
          featuredMedia { preview { image { url } } }
        }
        inventoryItem {
          id
          tracked
          unitCost { amount }
          inventoryLevels(first: 30) {
            nodes {
              location { id }
              quantities(names: ["available", "on_hand", "incoming"]) { name quantity }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/**
 * The catalog read page by page, producing the same lines a bulk operation would
 * (variants, then their inventory levels with __parentId). Used when a bulk operation fails.
 */
async function* catalogPages(admin: AdminClient, onProgress?: (n: number) => void): AsyncGenerator<Record<string, any>> {
  let after: string | null = null;
  let n = 0;
  do {
    let data: any;
    for (let attempt = 0; ; attempt++) {
      try {
        data = await gql(admin, CATALOG_PAGE, { after });
        break;
      } catch (err) {
        const throttled = JSON.stringify((err as any)?.details ?? "").includes("THROTTLED");
        if (!throttled || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    for (const v of data.productVariants.nodes) {
      const { inventoryLevels, ...item } = v.inventoryItem ?? {};
      yield { ...v, inventoryItem: v.inventoryItem ? item : null };
      for (const level of inventoryLevels?.nodes ?? []) yield { ...level, __parentId: v.id };
      n++;
    }
    onProgress?.(n);
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);
}

export async function syncCatalog(admin: AdminClient, shop: string, onProgress?: (n: number) => void) {
  let rows: AsyncGenerator<Record<string, any>>;
  try {
    rows = await runBulkQuery(admin, CATALOG_BULK_QUERY, (_s, n) => onProgress?.(n));
  } catch (err) {
    console.warn(`[stocksense] ${shop}: catalog bulk import failed (${(err as Error)?.message}), reading products page by page`);
    rows = catalogPages(admin, onProgress);
  }
  const variants: VariantRow[] = [];
  const levels: { variantId: string; locationId: string; available: number; onHand: number; incoming: number }[] = [];

  for await (const obj of rows) {
    if (obj.id?.startsWith("gid://shopify/ProductVariant/")) {
      variants.push({
        id: obj.id,
        productId: obj.product.id,
        inventoryItemId: obj.inventoryItem?.id ?? null,
        productTitle: obj.product.title,
        variantTitle: obj.title ?? null,
        sku: obj.sku || null,
        vendor: obj.product.vendor || null,
        // Shopify's own product type first, then the standard taxonomy category.
        productType: obj.product.productType || obj.product.category?.name || null,
        imageUrl: obj.product.featuredMedia?.preview?.image?.url ?? null,
        price: Number(obj.price ?? 0),
        unitCost: obj.inventoryItem?.unitCost?.amount != null ? Number(obj.inventoryItem.unitCost.amount) : null,
        status: obj.product.status,
        tracked: obj.inventoryItem?.tracked ?? true,
      });
    } else if (obj.location?.id && obj.__parentId) {
      // Inventory level lines are children of the variant line.
      const q = Object.fromEntries((obj.quantities ?? []).map((x: any) => [x.name, x.quantity]));
      levels.push({
        variantId: obj.__parentId,
        locationId: obj.location.id,
        available: q.available ?? 0,
        onHand: q.on_hand ?? q.available ?? 0,
        incoming: q.incoming ?? 0,
      });
    }
  }

  await upsertVariants(shop, variants);

  // Replace inventory levels wholesale: this import is the source of truth.
  await db.inventoryLevel.deleteMany({ where: { shop } });
  for (let i = 0; i < levels.length; i += 500) {
    await db.inventoryLevel.createMany({ data: levels.slice(i, i + 500).map((l) => ({ ...l, shop })) });
  }

  // Variants that no longer exist (deleted or archived) are removed with their forecasts.
  const ids = new Set(variants.map((v) => v.id));
  const existing = await db.variant.findMany({ where: { shop }, select: { id: true } });
  const gone = existing.filter((v) => !ids.has(v.id)).map((v) => v.id);
  for (let i = 0; i < gone.length; i += 500) {
    const chunk = gone.slice(i, i + 500);
    await db.forecast.deleteMany({ where: { variantId: { in: chunk } } });
    await db.variant.deleteMany({ where: { id: { in: chunk } } });
  }

  await db.shop.update({ where: { id: shop }, data: { lastInventorySyncAt: new Date() } });
  return { variants: variants.length, levels: levels.length };
}

export async function upsertVariants(shop: string, variants: VariantRow[]) {
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  const defaultLead = shopRow?.defaultLeadTimeDays ?? 14;

  // One supplier per vendor, created on first sight.
  const vendors = [...new Set(variants.map((v) => v.vendor).filter((v): v is string => !!v))];
  const suppliers = await db.supplier.findMany({ where: { shop } });
  // A supplier can supply several vendors (vendorKey is a comma separated list).
  const byVendor = new Map<string, string>();
  for (const sup of suppliers) {
    for (const key of (sup.vendorKey ?? "").split(",").map((k) => k.trim()).filter(Boolean)) byVendor.set(key, sup.id);
  }
  // Preferred supplier per product category, set from the supplier form or the reorder page.
  const byCategory = new Map<string, string>();
  for (const sup of suppliers) {
    for (const key of (sup.categoryKey ?? "").split(",").map((k) => k.trim()).filter(Boolean)) byCategory.set(key, sup.id);
  }
  const byName = new Map(suppliers.map((s) => [s.name.toLowerCase(), s.id]));
  for (const vendor of vendors) {
    if (byVendor.has(vendor)) continue;
    const existingId = byName.get(vendor.toLowerCase());
    if (existingId) {
      byVendor.set(vendor, existingId);
      continue;
    }
    const s = await db.supplier.create({
      data: { shop, name: vendor, vendorKey: vendor, defaultLeadTimeDays: defaultLead },
    });
    byVendor.set(vendor, s.id);
  }

  const existing = new Map(
    (await db.variant.findMany({ where: { shop }, select: { id: true, supplierId: true, unitCost: true, productType: true } })).map((v) => [v.id, v]),
  );

  for (let i = 0; i < variants.length; i += 200) {
    const chunk = variants.slice(i, i + 200);
    await db.$transaction(
      chunk.map((v) => {
        const prev = existing.get(v.id);
        // Product webhooks carry no taxonomy category: keep the one the last full sync found.
        const productType = v.productType ?? prev?.productType ?? null;
        // An existing assignment stays; new products follow their category, then their vendor.
        const supplierId =
          prev?.supplierId ?? (productType ? byCategory.get(productType) : undefined) ?? (v.vendor ? byVendor.get(v.vendor) ?? null : null);
        const data = {
          shop,
          productId: v.productId,
          inventoryItemId: v.inventoryItemId,
          productTitle: v.productTitle,
          variantTitle: v.variantTitle,
          sku: v.sku,
          vendor: v.vendor,
          productType,
          imageUrl: v.imageUrl,
          price: v.price,
          unitCost: v.unitCost ?? prev?.unitCost ?? null,
          status: v.status,
          tracked: v.tracked,
          supplierId,
        };
        return db.variant.upsert({ where: { id: v.id }, create: { id: v.id, ...data }, update: data });
      }),
    );
  }
}

/** products/create and products/update webhook payload (REST format). */
export async function ingestProductWebhook(shop: string, p: any) {
  const productId = `gid://shopify/Product/${p.id}`;
  if (p.status === "archived") {
    const ids = (await db.variant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id);
    await db.forecast.deleteMany({ where: { variantId: { in: ids } } });
    await db.variant.deleteMany({ where: { productId } });
    return;
  }
  const image = p.image?.src ?? p.images?.[0]?.src ?? null;
  const rows: VariantRow[] = (p.variants ?? []).map((v: any) => ({
    id: `gid://shopify/ProductVariant/${v.id}`,
    productId,
    inventoryItemId: v.inventory_item_id ? `gid://shopify/InventoryItem/${v.inventory_item_id}` : null,
    productTitle: p.title,
    variantTitle: v.title ?? null,
    sku: v.sku || null,
    vendor: p.vendor || null,
    productType: p.product_type || null,
    imageUrl: image,
    price: Number(v.price ?? 0),
    unitCost: null,
    status: String(p.status ?? "active").toUpperCase(),
    tracked: v.inventory_management === "shopify" || v.inventory_management == null,
  }));
  await upsertVariants(shop, rows);
  const keep = rows.map((r) => r.id);
  await db.variant.deleteMany({ where: { shop, productId, id: { notIn: keep } } });
}

export async function deleteProductWebhook(shop: string, p: any) {
  const productId = `gid://shopify/Product/${p.id}`;
  const ids = (await db.variant.findMany({ where: { shop, productId }, select: { id: true } })).map((v) => v.id);
  await db.forecast.deleteMany({ where: { shop, variantId: { in: ids } } });
  await db.variant.deleteMany({ where: { shop, productId } });
}

/** inventory_levels/update webhook payload: { inventory_item_id, location_id, available }. */
export async function ingestInventoryLevelWebhook(shop: string, p: any) {
  const itemId = `gid://shopify/InventoryItem/${p.inventory_item_id}`;
  const locationId = `gid://shopify/Location/${p.location_id}`;
  const variant = await db.variant.findFirst({ where: { shop, inventoryItemId: itemId }, select: { id: true } });
  if (!variant) return null;
  const available = Number(p.available ?? 0);
  const prev = await db.inventoryLevel.findUnique({ where: { variantId_locationId: { variantId: variant.id, locationId } } });
  // on_hand = available + committed/reserved; keep the previous gap when we only get available.
  const gap = prev ? prev.onHand - prev.available : 0;
  await db.inventoryLevel.upsert({
    where: { variantId_locationId: { variantId: variant.id, locationId } },
    create: { shop, variantId: variant.id, locationId, available, onHand: available, incoming: 0 },
    update: { available, onHand: available + Math.max(0, gap) },
  });
  return variant.id;
}
