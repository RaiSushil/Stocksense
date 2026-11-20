// End-to-end test of the server pipeline on demo data: forecasts, alerts, draft POs,
// the purchase order lifecycle, Ask tools, the REST API and order webhooks.
// Shopify is not called; the one mutation (receiving stock) uses a stub client.

import { beforeAll, describe, expect, it } from "vitest";
import db from "../db.server";
import { seedDemo } from "./demo.server";
import { dashboardData } from "./dashboard.server";
import { runTool } from "./ask/tools.server";
import { approvePo, receivePo, sendPo } from "./po.server";
import { createApiKey } from "./api/auth.server";
import { transferSuggestions } from "./transfers.server";
import { ingestOrderWebhook, syncOrderHistory, syncRecentOrders } from "./sync/orders.server";
import { categoryOptions, readSupplierForm, saveSupplier, setPreferredForCategories, validateSupplier } from "./supplier-form.server";
import { evaluateAlerts, phoneText } from "./alerts/run.server";
import { addDays, todayIn } from "./dates";
import { curveSummary, spotlightCandidates, stockCurve } from "./curve.server";
import { rebuildForecasts } from "./forecast/run.server";
import { ingestInventoryLevelWebhook, syncCatalog, syncLocations, syncShopInfo, upsertVariants } from "./sync/catalog.server";
import { syncErrorMessage } from "./jobs.server";
import { normalisePhone, phoneChannels, sendSms } from "./notify.server";
import { loader as forecastsApi } from "../routes/api.v1.forecasts._index";
import { ShopifyGraphQLError, type AdminClient } from "./shopify/admin.server";

const SHOP = "demo-test.myshopify.com";

async function variantBySku(sku: string) {
  return db.variant.findFirstOrThrow({ where: { shop: SHOP, sku } });
}

beforeAll(async () => {
  await db.shop.create({ data: { id: SHOP, name: "Demo Goods", plan: "PRO", timezone: "UTC", currency: "USD", alertEmail: "ops@example.com" } });
  const summary = await seedDemo(SHOP);
  expect(summary.forecasted).toBe(20);
}, 120_000);

describe("forecasts", () => {
  it("flags the fast hoodie as a stockout risk the supplier cannot cover", async () => {
    const v = await variantBySku("SKU-10428");
    const f = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: v.id, locationId: "" } } });
    expect(f.status).toBe("REORDER_NOW");
    expect(f.daysOfCover).toBeLessThan(f.leadTimeDays);
    expect(f.suggestedQty).toBeGreaterThan(50);
    expect(f.revenueAtRisk).toBeGreaterThan(0);
    const alert = await db.alert.findFirst({ where: { shop: SHOP, variantId: v.id, type: "STOCKOUT_RISK", status: "OPEN" } });
    expect(alert?.severity).toBe("CRITICAL");
  });

  it("marks slow-moving socks as overstocked with cash tied up", async () => {
    const v = await variantBySku("SKU-50077");
    const f = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: v.id, locationId: "" } } });
    expect(f.status).toBe("OVERSTOCKED");
    expect(f.overstockValue).toBeGreaterThan(1000);
  });

  it("builds per-location forecasts on multi-location plans", async () => {
    const count = await db.forecast.count({ where: { shop: SHOP, locationId: { not: "" } } });
    expect(count).toBe(40);
  });

  it("uses Croston for the intermittent seller", async () => {
    const v = await variantBySku("SKU-80120");
    const f = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: v.id, locationId: "" } } });
    expect(f.method).toBe("CROSTON");
  });
});

describe("alerts", () => {
  it("raises lead-time drift for Cedar & Co (9 to 21 days)", async () => {
    const a = await db.alert.findFirst({ where: { shop: SHOP, type: "LEAD_TIME_DRIFT", status: "OPEN" } });
    expect(a?.title).toBe("Cedar & Co");
    expect(a?.message).toContain("to 21 days");
  });

  it("raises a velocity alert for the shirt selling far above forecast", async () => {
    const v = await variantBySku("SKU-33190");
    const a = await db.alert.findFirst({ where: { shop: SHOP, variantId: v.id, type: "VELOCITY_SHIFT" } });
    expect(a).not.toBeNull();
    expect(a!.message).toMatch(/faster than forecast/);
  });

  it("does not re-notify an unchanged alert on the next run", async () => {
    const before = await db.alert.findMany({ where: { shop: SHOP, status: "OPEN" } });
    const res = await evaluateAlerts(SHOP);
    expect(res.notified).toBe(0);
    const after = await db.alert.findMany({ where: { shop: SHOP, status: "OPEN" } });
    expect(after.length).toBe(before.length);
  });
});

describe("purchase orders", () => {
  it("drafts one automatic PO per supplier that needs ordering", async () => {
    const drafts = await db.purchaseOrder.findMany({ where: { shop: SHOP, status: "DRAFT", source: "AUTO" }, include: { supplier: true, lines: true } });
    expect(drafts.length).toBeGreaterThan(0);
    const loomcraft = drafts.find((d) => d.supplier.name === "Loomcraft Mills");
    expect(loomcraft?.lines.length).toBeGreaterThan(0);
    expect(loomcraft?.expectedAt).not.toBeNull();
  });

  it("approves, sends and receives a PO, recording the real lead time", async () => {
    const po = await db.purchaseOrder.findFirstOrThrow({
      where: { shop: SHOP, status: "DRAFT", supplier: { name: "Loomcraft Mills" } },
      include: { lines: true },
    });
    // Demo variants have no inventory item; give one so receiving can adjust stock.
    await db.variant.update({ where: { id: po.lines[0].variantId }, data: { inventoryItemId: "gid://shopify/InventoryItem/1" } });
    await approvePo(SHOP, po.id);
    const sent = await sendPo(SHOP, po.id, true);
    expect(sent.po.status).toBe("SENT");
    expect(sent.emailed).toBe(false); // no SMTP in tests

    const calls: any[] = [];
    const stub: AdminClient = {
      graphql: async (_q, opts) => {
        calls.push(opts?.variables);
        return Response.json({ data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "x" }, userErrors: [] } } });
      },
    };
    const line = po.lines[0];
    const { complete } = await receivePo(stub, SHOP, po.id, { [line.id]: line.quantity });
    expect(calls[0].input.changes[0].delta).toBe(line.quantity);
    expect(calls[0].input.changes[0].changeFromQuantity).toBeNull();
    expect(typeof calls[0].key).toBe("string");
    expect(complete).toBe(po.lines.length === 1);
    const obs = await db.leadTimeObservation.findFirst({ where: { poId: po.id } });
    expect(obs?.source).toBe("PO_RECEIVED");
  });
});

describe("dashboard", () => {
  it("returns KPIs, chart, attention list and lead times", async () => {
    const d = await dashboardData(SHOP, "");
    expect(d.kpis.skusTracked).toBe(20);
    expect(d.kpis.needReorder).toBeGreaterThan(0);
    expect(d.kpis.cashInOverstock).toBeGreaterThan(0);
    expect(d.kpis.accuracy).not.toBeNull();
    expect(d.chart).toHaveLength(16);
    expect(d.chart.filter((c) => c.forecast)).toHaveLength(4);
    expect(d.attention[0].status).toBe("REORDER_NOW");
    expect(d.leadTimes.find((l) => l.name === "Cedar & Co")?.drift).toBeGreaterThan(5);
  });
});

describe("ask tools", () => {
  it("lists variants running out before a date", async () => {
    const res: any = await runTool("variants_running_out", { before_date: "2099-01-01" }, { shop: SHOP, createdPoIds: [] });
    expect(res.count).toBeGreaterThan(0);
    expect(res.variants[0]).toHaveProperty("days_of_cover");
  });

  it("drafts a purchase order that waits for approval", async () => {
    const v = await variantBySku("SKU-20871");
    const ctx = { shop: SHOP, createdPoIds: [] as string[] };
    const res: any = await runTool("draft_purchase_order", { lines: [{ variant_id: v.id, quantity: 220 }] }, ctx);
    expect(res.created).toBe(true);
    expect(res.status).toContain("DRAFT");
    expect(ctx.createdPoIds).toHaveLength(1);
  });
});

describe("transfers", () => {
  it("computes suggestions without errors", async () => {
    const s = await transferSuggestions(SHOP);
    expect(Array.isArray(s)).toBe(true);
  });
});

describe("REST API", () => {
  it("authenticates a key and lists forecasts with rate limit headers", async () => {
    const key = await createApiKey(SHOP, "test", false);
    const res = (await forecastsApi({
      request: new Request("https://stocksense.test/api/v1/forecasts?status=REORDER_NOW", { headers: { Authorization: `Bearer ${key}` } }),
      params: {},
      context: {},
    } as any)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("120");
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].status).toBe("REORDER_NOW");
  });

  it("rejects a bad key", async () => {
    await expect(
      forecastsApi({ request: new Request("https://stocksense.test/api/v1/forecasts", { headers: { Authorization: "Bearer nope" } }), params: {}, context: {} } as any),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("order webhooks", () => {
  it("adds units to today and ignores duplicate deliveries", async () => {
    const v = await variantBySku("SKU-61203");
    const numeric = v.id.split("/").pop();
    const payload = {
      id: 999001,
      admin_graphql_api_id: "gid://shopify/Order/999001",
      created_at: new Date().toISOString(),
      line_items: [{ variant_id: numeric, quantity: 3, price: "38.00", total_discount: "0.00", discount_allocations: [] }],
    };
    const today = todayIn("UTC");
    const before = await db.salesDaily.aggregate({ where: { variantId: v.id, date: today }, _sum: { units: true } });
    expect(await ingestOrderWebhook(SHOP, payload)).toHaveLength(1);
    expect(await ingestOrderWebhook(SHOP, payload)).toHaveLength(0);
    const after = await db.salesDaily.aggregate({ where: { variantId: v.id, date: today }, _sum: { units: true } });
    expect((after._sum.units ?? 0) - (before._sum.units ?? 0)).toBe(3);
  });
});

describe("stock curve", () => {
  it("rebuilds recent stock from sales and projects the run-out", async () => {
    const v = await variantBySku("SKU-10428");
    const c = await stockCurve(SHOP, v.id);
    expect(c).not.toBeNull();
    expect(c!.past).toHaveLength(14);
    // Stock was higher before recent sales.
    expect(c!.past[0]).toBeGreaterThan(c!.onHand);
    expect(c!.zeroDay).not.toBeNull();
    expect(c!.zeroDay!).toBeLessThan(c!.leadTimeDay);
    expect(c!.crossingDay !== null || c!.belowWholeWindow).toBe(true);
    const text = curveSummary(c!, 14);
    expect(text).toMatch(/Reaches zero in \d+ days?\./);
    expect(text).toContain("lands after it sells out");
  });

  it("puts the most revenue at risk first in the spotlight", async () => {
    const list = await spotlightCandidates(SHOP);
    const first = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: list[0].variantId, locationId: "" } } });
    const second = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: list[1].variantId, locationId: "" } } });
    expect(first.revenueAtRisk).toBeGreaterThanOrEqual(second.revenueAtRisk);
  });
});

describe("live refresh", () => {
  it("forecasts a product the moment its first sale arrives and tracks stock", async () => {
    const id = "gid://shopify/ProductVariant/990001";
    await db.variant.create({
      data: { id, shop: SHOP, productId: "gid://shopify/Product/990001", inventoryItemId: "gid://shopify/InventoryItem/990001", productTitle: "Test Mug", price: 20, unitCost: 8 },
    });
    const loc = (await db.location.findFirstOrThrow({ where: { shop: SHOP } })).id;
    await db.inventoryLevel.create({ data: { shop: SHOP, variantId: id, locationId: loc, available: 40, onHand: 40 } });
    await rebuildForecasts(SHOP, { variantIds: [id] });
    const before = await db.forecast.findUnique({ where: { variantId_locationId: { variantId: id, locationId: "" } } });
    expect(before?.method).toBe("NO_DATA");

    // A test purchase of 5 units: the order webhook, then the stock webhook.
    await ingestOrderWebhook(SHOP, {
      id: 990001,
      created_at: new Date().toISOString(),
      line_items: [{ variant_id: 990001, quantity: 5, price: "20.00", total_discount: "0" }],
    });
    await ingestInventoryLevelWebhook(SHOP, { inventory_item_id: 990001, location_id: loc.split("/").pop(), available: 35 });
    const others = await db.forecast.count({ where: { shop: SHOP } });
    await rebuildForecasts(SHOP, { variantIds: [id] });

    const after = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: id, locationId: "" } } });
    expect(after.method).toBe("NAIVE");
    expect(after.meanDaily).toBeCloseTo(5, 5);
    expect(after.onHand).toBe(35);
    expect(after.daysOfCover).toBeCloseTo(7, 0);
    // Other variants' forecasts are untouched by a partial refresh.
    expect(await db.forecast.count({ where: { shop: SHOP } })).toBe(others);
  });
});

describe("recent order sync", () => {
  it("counts fulfilled orders that never arrived by webhook, once", async () => {
    const id = "gid://shopify/ProductVariant/990002";
    await db.variant.create({
      data: { id, shop: SHOP, productId: "gid://shopify/Product/990002", inventoryItemId: "gid://shopify/InventoryItem/990002", productTitle: "Test Tee", price: 25, unitCost: 10 },
    });
    const order = (n: number, qty: number) => ({
      id: `gid://shopify/Order/77${n}`,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      test: false,
      displayFulfillmentStatus: "FULFILLED",
      retailLocation: null,
      fulfillments: [],
      lineItems: {
        nodes: [{ variant: { id }, quantity: qty, currentQuantity: qty, discountedTotalSet: { shopMoney: { amount: String(qty * 25) } }, totalDiscountSet: { shopMoney: { amount: "0" } } }],
      },
    });
    const stub: AdminClient = {
      graphql: async () => Response.json({ data: { orders: { nodes: [order(1, 2), order(2, 3)], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    };
    const demoRecent = () => db.salesDaily.count({ where: { shop: SHOP, variantId: { contains: "/demo-" }, date: { gte: addDays(todayIn("UTC"), -2) } } });
    const demoBefore = await demoRecent();
    expect(demoBefore).toBeGreaterThan(0);
    const first = await syncRecentOrders(stub, SHOP);
    expect(first.touched).toContain(id);
    const units = async () => (await db.salesDaily.aggregate({ where: { shop: SHOP, variantId: id }, _sum: { units: true } }))._sum.units;
    expect(await units()).toBe(5);
    // Demo sales in the same days are untouched.
    expect(await demoRecent()).toBe(demoBefore);
    // Running it again (every rebuild does) replaces the recent days instead of adding to them.
    await syncRecentOrders(stub, SHOP);
    expect(await units()).toBe(5);
    expect(await db.processedOrder.count({ where: { id: { in: ["gid://shopify/Order/771", "gid://shopify/Order/772"] } } })).toBe(2);

    await rebuildForecasts(SHOP, { variantIds: [id] });
    const f = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: id, locationId: "" } } });
    expect(f.meanDaily).toBeCloseTo(5, 5);
  });
});

describe("supplier form", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("rejects bad input with a message per field", async () => {
    const v = readSupplierForm(form({ name: "", email: "nope", phone: "abc", website: "x", leadTime: "0", minOrderValue: "-5" }));
    const e = await validateSupplier(SHOP, v);
    expect(Object.keys(e).sort()).toEqual(["email", "leadTime", "minOrderValue", "name", "phone", "website"].sort());
  });

  it("creates a supplier, assigns its vendor's products and blocks duplicate names", async () => {
    const vendor = (await db.variant.findFirstOrThrow({ where: { shop: SHOP, vendor: { not: null } } })).vendor!;
    const fields = { name: "Harbor Textiles", email: "orders@harbor.example", leadTime: "21", minOrderValue: "500", currency: "USD", paymentTerms: "NET_30", vendors: vendor };
    const v = readSupplierForm(form(fields));
    expect(await validateSupplier(SHOP, v)).toEqual({});
    const savedId = await saveSupplier(SHOP, v);
    const variants = await db.variant.findMany({ where: { shop: SHOP, vendor } });
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((x) => x.supplierId === savedId)).toBe(true);
    expect((await validateSupplier(SHOP, v)).name).toMatch(/already exists/);
    expect(await validateSupplier(SHOP, v, savedId)).toEqual({});
  });
});

describe("preferred supplier by category", () => {
  it("assigns the whole category, moves it off the old supplier and applies to new products", async () => {
    const [a, b] = await Promise.all([
      db.supplier.create({ data: { shop: SHOP, name: "Wick & Wax", defaultLeadTimeDays: 9 } }),
      db.supplier.create({ data: { shop: SHOP, name: "Ember Supply", defaultLeadTimeDays: 12 } }),
    ]);
    await setPreferredForCategories(SHOP, a.id, ["Candles"]);
    let candles = await db.variant.findMany({ where: { shop: SHOP, productType: "Candles" } });
    expect(candles.length).toBeGreaterThan(0);
    expect(candles.every((v) => v.supplierId === a.id)).toBe(true);

    // Moving the category to another supplier takes it off the first one.
    await setPreferredForCategories(SHOP, b.id, ["Candles"]);
    candles = await db.variant.findMany({ where: { shop: SHOP, productType: "Candles" } });
    expect(candles.every((v) => v.supplierId === b.id)).toBe(true);
    expect((await db.supplier.findUniqueOrThrow({ where: { id: a.id } })).categoryKey).toBeNull();
    const opts = await categoryOptions(SHOP);
    expect(opts.find((o) => o.category === "Candles")?.supplier).toBe("Ember Supply");

    // A brand-new product in the category follows the preference, not its vendor.
    await upsertVariants(SHOP, [
      {
        id: "gid://shopify/ProductVariant/990003",
        productId: "gid://shopify/Product/990003",
        inventoryItemId: "gid://shopify/InventoryItem/990003",
        productTitle: "Fig Candle",
        variantTitle: null,
        sku: "FIG-1",
        vendor: "Some New Vendor",
        productType: "Candles",
        imageUrl: null,
        price: 30,
        unitCost: 9,
        status: "ACTIVE",
        tracked: true,
      },
    ]);
    expect((await db.variant.findUniqueOrThrow({ where: { id: "gid://shopify/ProductVariant/990003" } })).supplierId).toBe(b.id);

    // A product webhook (no taxonomy category) keeps the category found earlier.
    await upsertVariants(SHOP, [
      {
        id: "gid://shopify/ProductVariant/990003",
        productId: "gid://shopify/Product/990003",
        inventoryItemId: "gid://shopify/InventoryItem/990003",
        productTitle: "Fig Candle",
        variantTitle: null,
        sku: "FIG-1",
        vendor: "Some New Vendor",
        productType: null,
        imageUrl: null,
        price: 30,
        unitCost: 9,
        status: "ACTIVE",
        tracked: true,
      },
    ]);
    expect((await db.variant.findUniqueOrThrow({ where: { id: "gid://shopify/ProductVariant/990003" } })).productType).toBe("Candles");
  });

  it("supplier form saves categories", async () => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ name: "Kitchen Direct", leadTime: "10", minOrderValue: "0" })) f.set(k, v);
    f.append("categories", "Kitchen");
    const v = readSupplierForm(f);
    const id = await saveSupplier(SHOP, v);
    const kitchen = await db.variant.findMany({ where: { shop: SHOP, productType: "Kitchen" } });
    expect(kitchen.length).toBeGreaterThan(0);
    expect(kitchen.every((x) => x.supplierId === id)).toBe(true);
    expect((await db.supplier.findUniqueOrThrow({ where: { id } })).categoryKey).toBe("Kitchen");
  });
});

describe("development stores and failed bulk imports", () => {
  const DEV = "devstore-test.myshopify.com";
  const variant = "gid://shopify/ProductVariant/880001";
  const recentOrder = (id: number, qty: number, test: boolean) => ({
    id: `gid://shopify/Order/88${id}`,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    test,
    retailLocation: null,
    fulfillments: [],
    lineItems: { nodes: [{ variant: { id: variant }, quantity: qty, currentQuantity: qty, discountedTotalSet: { shopMoney: { amount: "10" } }, totalDiscountSet: { shopMoney: { amount: "0" } } }] },
  });
  const catalogVariant = {
    id: variant,
    title: "Default",
    sku: "DEV-1",
    price: "10.00",
    product: { id: "gid://shopify/Product/880001", title: "Dev Tee", vendor: "Dev Vendor", productType: "", category: { name: "T-Shirts" }, status: "ACTIVE", featuredMedia: null },
    inventoryItem: {
      id: "gid://shopify/InventoryItem/880001",
      tracked: true,
      unitCost: { amount: "4.00" },
      inventoryLevels: { nodes: [{ location: { id: "gid://shopify/Location/1" }, quantities: [{ name: "available", quantity: 46 }, { name: "on_hand", quantity: 46 }, { name: "incoming", quantity: 0 }] }] },
    },
  };
  // Every bulk operation fails, like the merchant's "Bulk operation FAILED".
  const stub = (orders: unknown[], devStore = true): AdminClient => ({
    graphql: async (query: string) => {
      if (query.includes("bulkOperationRunQuery")) return Response.json({ data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" }, userErrors: [] } } });
      if (query.includes("StockSenseBulkStatus")) return Response.json({ data: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "FAILED", errorCode: "INTERNAL_SERVER_ERROR", objectCount: "0" } } });
      if (query.includes("StockSenseShop")) return Response.json({ data: { shop: { name: "Dev", email: "dev@example.com", ianaTimezone: "UTC", currencyCode: "USD", plan: { partnerDevelopment: devStore } } } });
      if (query.includes("StockSenseLocations")) return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Shop location", isActive: true }], pageInfo: { hasNextPage: false } } } });
      if (query.includes("StockSenseCatalogPage")) return Response.json({ data: { productVariants: { nodes: [catalogVariant], pageInfo: { hasNextPage: false, endCursor: null } } } });
      if (query.includes("StockSenseRecentOrders")) return Response.json({ data: { orders: { nodes: orders, pageInfo: { hasNextPage: false, endCursor: null } } } });
      throw new Error(`unexpected query ${query.slice(0, 60)}`);
    },
  });

  it("imports a development store's test orders even when every bulk operation fails", async () => {
    await db.shop.create({ data: { id: DEV, plan: "PRO" } });
    const admin = stub([recentOrder(1, 11, true), recentOrder(2, 1, true)]);
    await syncShopInfo(admin, DEV);
    expect((await db.shop.findUniqueOrThrow({ where: { id: DEV } })).isDevStore).toBe(true);
    await syncLocations(admin, DEV);
    await syncCatalog(admin, DEV);
    const v = await db.variant.findUniqueOrThrow({ where: { id: variant } });
    expect(v.productType).toBe("T-Shirts");
    expect(await db.inventoryLevel.count({ where: { shop: DEV, variantId: variant } })).toBe(1);

    await syncOrderHistory(admin, DEV);
    const units = (await db.salesDaily.aggregate({ where: { shop: DEV, variantId: variant }, _sum: { units: true } }))._sum.units;
    expect(units).toBe(12);
    await rebuildForecasts(DEV);
    const f = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: variant, locationId: "" } } });
    expect(f.status).not.toBe("NO_DATA");
  }, 30_000);

  it("still ignores test orders on a live store", async () => {
    await db.shop.update({ where: { id: DEV }, data: { isDevStore: false } });
    await syncRecentOrders(stub([recentOrder(3, 5, true)], false), DEV);
    expect((await db.salesDaily.aggregate({ where: { shop: DEV, variantId: variant }, _sum: { units: true } }))._sum.units ?? 0).toBe(0);
    const touched = await ingestOrderWebhook(DEV, { id: 884, test: true, created_at: new Date().toISOString(), line_items: [{ variant_id: 880001, quantity: 2, price: "10" }] });
    expect(touched).toEqual([]);
    await db.shop.update({ where: { id: DEV }, data: { isDevStore: true } });
    const touchedDev = await ingestOrderWebhook(DEV, { id: 885, test: true, created_at: new Date().toISOString(), line_items: [{ variant_id: 880001, quantity: 2, price: "10" }] });
    expect(touchedDev).toEqual([variant]);
  });

  it("explains a refused order import in words the merchant can act on", () => {
    const msg = syncErrorMessage("Importing two years of orders", new ShopifyGraphQLError("Bulk operation FAILED (ACCESS_DENIED)", "ACCESS_DENIED"));
    expect(msg).toMatch(/Protected customer data/);
    expect(syncErrorMessage("Importing products and inventory", new Error("boom"))).toBe("Importing products and inventory failed: boom");
  });
});

describe("phone alerts", () => {
  it("normalises numbers and keeps messages short", () => {
    expect(normalisePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalisePhone("0091 98765 43210")).toBe("+919876543210");
    expect(normalisePhone("98765 43210")).toBeNull();
    const alerts = Array.from({ length: 5 }, (_, i) => ({ type: "STOCKOUT_RISK", severity: "CRITICAL", title: `Item ${i}`, message: "runs out in 3 days", revenueAtRisk: 100 })) as never[];
    const text = phoneText("Demo", alerts, (n) => `$${n}`, "https://example.com/alerts");
    expect(text.split("\n")).toHaveLength(6);
    expect(text).toContain("+2 more");
  });

  it("reports when Twilio is not set up instead of throwing", async () => {
    const r = await sendSms("+919876543210", "hi");
    expect(r.ok).toBe(false);
    expect(phoneChannels().sms).toBe(false);
  });
});
