// Demo data for development stores, which usually have no order history.
// Creates suppliers, variants, two locations and about 14 months of realistic sales
// (weekly pattern, trends, past promotions), then builds forecasts and alerts.
// Variant ids use a "demo" namespace so they never collide with real products.

import db from "../db.server";
import { evaluateAlerts } from "./alerts/run.server";
import { addDays, todayIn, weekday } from "./dates";
import { rebuildForecasts } from "./forecast/run.server";
import { syncAutoDrafts } from "./po.server";

const DAYS = 420;

interface DemoItem {
  product: string;
  variant: string;
  sku: string;
  supplier: string;
  price: number;
  cost: number;
  rate: number; // average units per day today
  trend: number; // multiplier change across the history (1.4 = grew 40%)
  weekend: number; // weekend multiplier
  stock: number; // units on hand today (split across locations)
  retailShare: number;
}

const ITEMS: DemoItem[] = [
  { product: "Midnight Hoodie", variant: "Black / L", sku: "SKU-10428", supplier: "Loomcraft Mills", price: 68, cost: 21, rate: 1.8, trend: 1.5, weekend: 1.4, stock: 11, retailShare: 0.3 },
  { product: "Midnight Hoodie", variant: "Black / M", sku: "SKU-10427", supplier: "Loomcraft Mills", price: 68, cost: 21, rate: 1.5, trend: 1.4, weekend: 1.4, stock: 30, retailShare: 0.3 },
  { product: "Midnight Hoodie", variant: "Navy / L", sku: "SKU-10431", supplier: "Loomcraft Mills", price: 68, cost: 21, rate: 1.0, trend: 1.2, weekend: 1.3, stock: 26, retailShare: 0.3 },
  { product: "Midnight Hoodie", variant: "Navy / M", sku: "SKU-10430", supplier: "Loomcraft Mills", price: 68, cost: 21, rate: 0.9, trend: 1.1, weekend: 1.3, stock: 70, retailShare: 0.3 },
  { product: "Linen Shirt", variant: "Sand / M", sku: "SKU-33190", supplier: "Loomcraft Mills", price: 54, cost: 17, rate: 4.2, trend: 1.3, weekend: 1.5, stock: 126, retailShare: 0.4 },
  { product: "Linen Shirt", variant: "Sand / L", sku: "SKU-33191", supplier: "Loomcraft Mills", price: 54, cost: 17, rate: 3.1, trend: 1.2, weekend: 1.5, stock: 160, retailShare: 0.4 },
  { product: "Linen Shirt", variant: "White / M", sku: "SKU-33192", supplier: "Loomcraft Mills", price: 54, cost: 17, rate: 2.4, trend: 1.0, weekend: 1.4, stock: 210, retailShare: 0.4 },
  { product: "Cedar Candle", variant: "220g", sku: "SKU-20871", supplier: "Cedar & Co", price: 32, cost: 9, rate: 5.3, trend: 1.3, weekend: 1.6, stock: 48, retailShare: 0.5 },
  { product: "Cedar Candle", variant: "450g", sku: "SKU-20872", supplier: "Cedar & Co", price: 48, cost: 14, rate: 2.2, trend: 1.2, weekend: 1.6, stock: 95, retailShare: 0.5 },
  { product: "Fig Candle", variant: "220g", sku: "SKU-20891", supplier: "Cedar & Co", price: 32, cost: 9, rate: 1.6, trend: 0.9, weekend: 1.5, stock: 140, retailShare: 0.5 },
  { product: "Trail Mug", variant: "350ml", sku: "SKU-41552", supplier: "Northline Supply", price: 24, cost: 6, rate: 9.5, trend: 1.1, weekend: 1.2, stock: 210, retailShare: 0.35 },
  { product: "Trail Mug", variant: "500ml", sku: "SKU-41553", supplier: "Northline Supply", price: 28, cost: 7, rate: 4.0, trend: 1.0, weekend: 1.2, stock: 160, retailShare: 0.35 },
  { product: "Wool Socks", variant: "Grey", sku: "SKU-50077", supplier: "Northline Supply", price: 18, cost: 5, rate: 19.5, trend: 0.7, weekend: 1.1, stock: 2600, retailShare: 0.2 },
  { product: "Wool Socks", variant: "Oat", sku: "SKU-50078", supplier: "Northline Supply", price: 18, cost: 5, rate: 6, trend: 0.8, weekend: 1.1, stock: 900, retailShare: 0.2 },
  { product: "Canvas Tote", variant: "Natural", sku: "SKU-61203", supplier: "Volta Goods", price: 38, cost: 11, rate: 15.6, trend: 1.2, weekend: 1.3, stock: 642, retailShare: 0.45 },
  { product: "Canvas Tote", variant: "Black", sku: "SKU-61204", supplier: "Volta Goods", price: 38, cost: 11, rate: 7.8, trend: 1.1, weekend: 1.3, stock: 140, retailShare: 0.45 },
  { product: "Field Notebook", variant: "A5 Dot", sku: "SKU-72011", supplier: "Volta Goods", price: 16, cost: 4, rate: 6.5, trend: 1.0, weekend: 0.8, stock: 380, retailShare: 0.3 },
  { product: "Field Notebook", variant: "A5 Lined", sku: "SKU-72012", supplier: "Volta Goods", price: 16, cost: 4, rate: 3.5, trend: 1.0, weekend: 0.8, stock: 520, retailShare: 0.3 },
  { product: "Brass Bottle Opener", variant: "Default Title", sku: "SKU-80110", supplier: "Volta Goods", price: 22, cost: 6, rate: 0.25, trend: 0.8, weekend: 1.5, stock: 60, retailShare: 0.6 },
  { product: "Enamel Pin Set", variant: "Default Title", sku: "SKU-80120", supplier: "Volta Goods", price: 14, cost: 3, rate: 0.12, trend: 1.0, weekend: 1.0, stock: 3, retailShare: 0.6 },
];

const SUPPLIERS: Record<string, { lead: number; email: string; history: number[] }> = {
  "Loomcraft Mills": { lead: 17, email: "orders@loomcraft.example", history: [16, 18, 17] },
  "Cedar & Co": { lead: 9, email: "sales@cedarco.example", history: [9, 9, 10, 21] },
  "Northline Supply": { lead: 6, email: "po@northline.example", history: [6, 6, 7] },
  "Volta Goods": { lead: 11, email: "orders@volta.example", history: [11, 12, 10] },
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function poisson(lambda: number, r: () => number) {
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * (r() + r() + r() - 1.5) * 2));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}

export async function seedDemo(shop: string) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const today = todayIn(shopRow.timezone);
  const start = addDays(today, -DAYS);
  await clearDemo(shop);

  const retail = `gid://shopify/Location/demo-retail-${shop}`;
  const warehouse = `gid://shopify/Location/demo-warehouse-${shop}`;
  await db.location.createMany({
    data: [
      { id: retail, shop, name: "Retail Store" },
      { id: warehouse, shop, name: "Wholesale Warehouse" },
    ],
  });

  const supplierIds = new Map<string, string>();
  for (const [name, s] of Object.entries(SUPPLIERS)) {
    const sup = await db.supplier.upsert({
      where: { shop_name: { shop, name } },
      create: { shop, name, email: s.email, defaultLeadTimeDays: s.lead, vendorKey: name },
      update: { email: s.email, defaultLeadTimeDays: s.lead },
    });
    supplierIds.set(name, sup.id);
    // Lead time history: the last observation is recent, so drift shows up today.
    const n = s.history.length;
    for (let i = 0; i < n; i++) {
      await db.leadTimeObservation.create({
        data: {
          shop,
          supplierId: sup.id,
          days: s.history[i],
          source: "PO_RECEIVED",
          observedAt: new Date(Date.now() - (i === n - 1 ? 0.2 : (n - i) * 25) * 86_400_000),
        },
      });
    }
  }

  const r = rng(42);
  // Two past promotions (a spring sale and last year's Black Friday weekend).
  const promoDays = new Set<string>();
  for (const [from, len] of [[addDays(today, -200), 4], [addDays(today, -355), 4]] as [string, number][]) {
    for (let i = 0; i < len; i++) promoDays.add(addDays(from, i));
  }

  for (let idx = 0; idx < ITEMS.length; idx++) {
    const it = ITEMS[idx];
    const id = `gid://shopify/ProductVariant/demo-${idx + 1}-${shop}`;
    await db.variant.create({
      data: {
        id,
        shop,
        productId: `gid://shopify/Product/demo-${it.product.replace(/\W+/g, "-").toLowerCase()}-${shop}`,
        inventoryItemId: null,
        productTitle: it.product,
        variantTitle: it.variant,
        sku: it.sku,
        vendor: it.supplier,
        productType: it.product.includes("Candle") ? "Candles" : it.product.includes("Mug") ? "Kitchen" : "Apparel",
        price: it.price,
        unitCost: it.cost,
        status: "ACTIVE",
        supplierId: supplierIds.get(it.supplier),
        casePack: it.product.includes("Socks") ? 12 : 1,
        firstSoldAt: new Date(`${start}T00:00:00Z`),
      },
    });

    const rows = [];
    for (let d = 0; d < DAYS; d++) {
      const date = addDays(start, d);
      const progress = d / DAYS;
      const trend = 1 / it.trend + (1 - 1 / it.trend) * progress; // ends at 1.0 x rate
      const w = weekday(date);
      const weekend = w === 0 || w === 6 ? it.weekend : 1;
      const promo = promoDays.has(date) ? 2.5 : 1;
      // The Linen Shirt starts selling far above forecast over the last 3 days (velocity alert).
      const spike = it.sku === "SKU-33190" && d >= DAYS - 2 ? 2.6 : 1;
      const lambda = it.rate * trend * weekend * promo * spike;
      const units = poisson(lambda, r);
      if (!units) continue;
      const retailUnits = Math.round(units * it.retailShare);
      const onlineUnits = units - retailUnits;
      const disc = promo > 1;
      const price = disc ? it.price * 0.75 : it.price;
      if (retailUnits) rows.push({ shop, variantId: id, locationId: retail, date, units: retailUnits, revenue: retailUnits * price, discountUnits: disc ? retailUnits : 0 });
      if (onlineUnits) rows.push({ shop, variantId: id, locationId: warehouse, date, units: onlineUnits, revenue: onlineUnits * price, discountUnits: disc ? onlineUnits : 0 });
    }
    // Today so far: the shirt keeps selling fast (orders arriving by webhook).
    if (it.sku === "SKU-33190") {
      const units = Math.round(it.rate * 2.6 * 0.7);
      rows.push({ shop, variantId: id, locationId: warehouse, date: today, units, revenue: units * it.price, discountUnits: 0 });
    }
    for (let i = 0; i < rows.length; i += 500) await db.salesDaily.createMany({ data: rows.slice(i, i + 500) });

    const atRetail = Math.round(it.stock * (it.stock < 60 ? 0.2 : 0.35));
    await db.inventoryLevel.createMany({
      data: [
        { shop, variantId: id, locationId: retail, available: atRetail, onHand: atRetail },
        { shop, variantId: id, locationId: warehouse, available: it.stock - atRetail, onHand: it.stock - atRetail },
      ],
    });
  }

  await db.shop.update({ where: { id: shop }, data: { syncStatus: "READY", syncStage: null, lastFullSyncAt: new Date() } });
  const summary = await rebuildForecasts(shop);
  // A month-old accuracy snapshot so the dashboard shows a trend.
  if (summary.accuracy !== null) {
    await db.accuracySnapshot.upsert({
      where: { shop_date: { shop, date: addDays(today, -30) } },
      create: { shop, date: addDays(today, -30), accuracy: Math.max(0, summary.accuracy - 0.021), skuCount: summary.forecasted },
      update: {},
    });
  }
  await syncAutoDrafts(shop);
  await evaluateAlerts(shop);
  return summary;
}

export async function clearDemo(shop: string) {
  const demoVariants = (await db.variant.findMany({ where: { shop, id: { contains: "/demo-" } }, select: { id: true } })).map((v) => v.id);
  await db.$transaction([
    db.purchaseOrderLine.deleteMany({ where: { variantId: { in: demoVariants } } }),
    db.purchaseOrder.deleteMany({ where: { shop, lines: { none: {} } } }),
    db.alert.deleteMany({ where: { shop } }),
    db.forecast.deleteMany({ where: { variantId: { in: demoVariants } } }),
    db.salesDaily.deleteMany({ where: { variantId: { in: demoVariants } } }),
    db.inventoryLevel.deleteMany({ where: { variantId: { in: demoVariants } } }),
    db.variant.deleteMany({ where: { id: { in: demoVariants } } }),
    db.location.deleteMany({ where: { shop, id: { contains: "/demo-" } } }),
    db.leadTimeObservation.deleteMany({ where: { shop, supplier: { name: { in: Object.keys(SUPPLIERS) } } } }),
  ]);
}
