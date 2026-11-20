// Every store's data is separate. These tests run two stores side by side and try to
// reach one store's records from the other through each way in: app pages and forms,
// the REST API, Ask StockSense, WhatsApp and the privacy webhook.

import { beforeAll, describe, expect, it, vi } from "vitest";
import db from "../db.server";
import { seedDemo } from "./demo.server";
import { createApiKey } from "./api/auth.server";
import { createDraftPo } from "./po.server";
import { rebuildForecasts } from "./forecast/run.server";
import { runTool } from "./ask/tools.server";
import { ActionError, decide, propose } from "./whatsapp/actions.server";
import { activeLink, createLinkCode, repliesFor } from "./whatsapp/inbox.server";
import { optionsOf } from "./whatsapp/provider.server";

// App pages sign in through Shopify; here the store comes from a test header.
vi.mock("./context.server", () => ({
  adminContext: async (request: Request) => {
    const { default: prisma } = await import("../db.server");
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: request.headers.get("x-test-shop")! } });
    return { shop, admin: { graphql: async () => Response.json({ data: {} }) }, session: { shop: shop.id }, billing: {} };
  },
}));

const A = "tenant-a.myshopify.com";
const B = "tenant-b.myshopify.com";
const PHONE = "+447700900123";

const req = (shop: string, url = "https://stocksense.test/app", init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { ...(init.headers ?? {}), "x-test-shop": shop } });
const form = (shop: string, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return req(shop, "https://stocksense.test/app", { method: "POST", body });
};
const counts = async (shop: string) => ({
  variants: await db.variant.count({ where: { shop } }),
  forecasts: await db.forecast.count({ where: { shop } }),
  suppliers: await db.supplier.count({ where: { shop } }),
  pos: await db.purchaseOrder.count({ where: { shop } }),
  alerts: await db.alert.count({ where: { shop } }),
  sales: await db.salesDaily.count({ where: { shop } }),
});

let bPo: { id: string; number: string; supplierId: string };
let bVariant: string;
let bSupplier: string;
let bAlert: string;

beforeAll(async () => {
  for (const [id, name] of [
    [A, "Store A"],
    [B, "Store B"],
  ]) {
    await db.shop.create({ data: { id, name, plan: "PRO", timezone: "UTC", currency: "USD" } });
    await seedDemo(id);
  }
  const v = await db.variant.findFirstOrThrow({ where: { shop: B, supplierId: { not: null } } });
  bVariant = v.id;
  bSupplier = v.supplierId!;
  const po = await createDraftPo(B, { supplierId: bSupplier, source: "MANUAL", lines: [{ variantId: v.id, quantity: 10 }] });
  bPo = { id: po.id, number: po.number, supplierId: po.supplierId };
  bAlert = (await db.alert.findFirstOrThrow({ where: { shop: B, status: "OPEN" } })).id;
}, 240_000);

describe("each store's data is its own", () => {
  it("keeps catalogs, forecasts, suppliers and PO numbers separate", async () => {
    const a = await counts(A);
    const b = await counts(B);
    expect(a.variants).toBe(b.variants);
    // Same demo catalog, different records.
    const aIds = new Set((await db.variant.findMany({ where: { shop: A }, select: { id: true } })).map((v) => v.id));
    expect((await db.variant.findMany({ where: { shop: B }, select: { id: true } })).some((v) => aIds.has(v.id))).toBe(false);
    // Purchase order numbers count per store, so both can have PO-1001.
    const aPo = await createDraftPo(A, {
      supplierId: (await db.supplier.findFirstOrThrow({ where: { shop: A } })).id,
      source: "MANUAL",
      lines: [{ variantId: [...aIds][0], quantity: 1 }],
    });
    expect(aPo.number).toMatch(/^PO-\d+$/);
    expect(await db.purchaseOrder.count({ where: { number: aPo.number } })).toBeGreaterThanOrEqual(1);
  });

  it("rebuilding one store leaves the other untouched", async () => {
    const before = await counts(B);
    const bForecast = await db.forecast.findFirstOrThrow({ where: { shop: B }, orderBy: { variantId: "asc" } });
    await rebuildForecasts(A);
    expect(await counts(B)).toEqual(before);
    const again = await db.forecast.findUniqueOrThrow({ where: { variantId_locationId: { variantId: bForecast.variantId, locationId: bForecast.locationId } } });
    expect(again.computedAt.getTime()).toBe(bForecast.computedAt.getTime());
  });
});

describe("app pages and forms", () => {
  it("cannot open another store's purchase order, supplier, product or reorder screen", async () => {
    const { loader: poLoader } = await import("../routes/app.purchase-orders.$id");
    const { loader: supplierLoader } = await import("../routes/app.suppliers.$id");
    const { loader: skuLoader } = await import("../routes/app.forecasts.$variantId");
    const { loader: reorderLoader } = await import("../routes/app.reorder.$variantId");
    const vid = bVariant.split("/").pop()!;
    await expect(poLoader({ request: req(A), params: { id: bPo.id }, context: {} } as never)).rejects.toBeTruthy();
    await expect(supplierLoader({ request: req(A), params: { id: bSupplier }, context: {} } as never)).rejects.toBeTruthy();
    await expect(skuLoader({ request: req(A), params: { variantId: vid }, context: {} } as never)).rejects.toBeTruthy();
    await expect(reorderLoader({ request: req(A), params: { variantId: vid }, context: {} } as never)).rejects.toBeTruthy();
    // The owner can, so the refusals above come from the store check.
    await expect(poLoader({ request: req(B), params: { id: bPo.id }, context: {} } as never)).resolves.toBeTruthy();
    await expect(supplierLoader({ request: req(B), params: { id: bSupplier }, context: {} } as never)).resolves.toBeTruthy();
    await expect(skuLoader({ request: req(B), params: { variantId: vid }, context: {} } as never)).resolves.toBeTruthy();
    await expect(reorderLoader({ request: req(B), params: { variantId: vid }, context: {} } as never)).resolves.toBeTruthy();
  });

  it("cannot change another store's records through form ids", async () => {
    const { action: alertsAction } = await import("../routes/app.alerts");
    await alertsAction({ request: form(A, { intent: "dismiss", id: bAlert }), params: {}, context: {} } as never);
    expect((await db.alert.findUniqueOrThrow({ where: { id: bAlert } })).status).toBe("OPEN");

    const { action: poAction } = await import("../routes/app.purchase-orders.$id");
    await poAction({ request: form(A, { intent: "approve" }), params: { id: bPo.id }, context: {} } as never).catch(() => null);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: bPo.id } })).status).toBe("DRAFT");

    // A store's product cannot point at another store's supplier.
    const aVariant = await db.variant.findFirstOrThrow({ where: { shop: A } });
    const { action: skuAction } = await import("../routes/app.forecasts.$variantId");
    const res = await skuAction({ request: form(A, { intent: "settings", supplierId: bSupplier, casePack: "1" }), params: { variantId: aVariant.id.split("/").pop()! }, context: {} } as never);
    expect(res).toEqual({ error: "That supplier was not found." });
    expect((await db.variant.findUniqueOrThrow({ where: { id: aVariant.id } })).supplierId).not.toBe(bSupplier);

    // A purchase order cannot be sent to another store's location.
    const bLocation = (await db.location.findFirstOrThrow({ where: { shop: B } })).id;
    const aPo = await createDraftPo(A, { supplierId: aVariant.supplierId!, source: "MANUAL", lines: [{ variantId: aVariant.id, quantity: 2 }], locationId: bLocation });
    expect(aPo.locationId).not.toBe(bLocation);
  });

  it("Ask StockSense only sees its own store", async () => {
    const out = (await runTool("variant_detail", { variant_id: bVariant }, { shop: A, createdPoIds: [], charts: [] })) as { error?: string };
    expect(out.error).toBe("Variant not found");
    const thread = await db.askThread.create({ data: { shop: B, title: "B secret" } });
    await db.askMessage.create({ data: { threadId: thread.id, role: "user", content: "B question" } });
    const { loader: askLoader } = await import("../routes/app.ask-api");
    const data = (await askLoader({ request: req(A, `https://stocksense.test/app/ask-api?thread=${thread.id}`), params: {}, context: {} } as never)) as {
      threads: { id: string }[];
      messages: unknown[];
    };
    expect(data.threads.some((t) => t.id === thread.id)).toBe(false);
    expect(data.messages).toEqual([]);
  });
});

describe("REST API", () => {
  it("an API key only reaches its own store", async () => {
    const key = await createApiKey(A, "erp", false);
    const auth = { Authorization: `Bearer ${key}` };
    const { loader: poApi } = await import("../routes/api.v1.purchase-orders.$id");
    await expect(poApi({ request: new Request(`https://stocksense.test/api/v1/purchase-orders/${bPo.id}`, { headers: auth }), params: { id: bPo.id }, context: {} } as never)).rejects.toMatchObject({
      status: 404,
    });
    const { action: createApi } = await import("../routes/api.v1.purchase-orders._index");
    await expect(
      createApi({
        request: new Request("https://stocksense.test/api/v1/purchase-orders", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ supplier_id: bSupplier, lines: [{ variant_id: bVariant, quantity: 1 }] }),
        }),
        params: {},
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("WhatsApp with one phone on two stores", () => {
  it("links the same phone to both stores and switches between them", async () => {
    for (const shop of [A, B]) {
      const code = await createLinkCode(shop);
      await repliesFor({ messageId: `link-${shop}`, phone: PHONE, text: `link ${code.code}` });
    }
    expect(await db.whatsappLink.count({ where: { phone: PHONE } })).toBe(2);
    expect((await activeLink(PHONE))?.shop).toBe(B);

    const settings = await repliesFor({ messageId: "s1", phone: PHONE, text: "", replyId: "set" });
    expect(optionsOf(settings[0]).map((o) => o.id)).toContain("sw");
    const list = await repliesFor({ messageId: "s2", phone: PHONE, text: "", replyId: "sw" });
    const toA = optionsOf(list[0]).find((o) => o.title === "Store A")!;
    const switched = await repliesFor({ messageId: "s3", phone: PHONE, text: "", replyId: toA.id });
    expect(switched[0].text).toMatch(/Switched to \*Store A\*/);
    expect((await activeLink(PHONE))?.shop).toBe(A);
  });

  it("menus and proposals only use the active store's records", async () => {
    // Store A is active: Store B's purchase order is out of reach.
    const card = await repliesFor({ messageId: "p1", phone: PHONE, text: "", replyId: `po:${bPo.id}` });
    expect(card[0].text).toMatch(/not found/);
    await expect(propose(A, PHONE, "APPROVE_PO", { poId: bPo.id })).rejects.toBeInstanceOf(ActionError);
    await expect(propose(A, PHONE, "DISMISS_ALERT", { alertId: bAlert })).rejects.toBeInstanceOf(ActionError);
  });

  it("an approval runs against the store it was made for, and only while the phone is linked to it", async () => {
    const p = await propose(B, PHONE, "APPROVE_PO", { poId: bPo.id });
    // The phone is active on A, but the request belongs to B and the phone is linked to B.
    expect((await decide(PHONE, p.id, "approve")).text).toMatch(/is approved/);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: bPo.id } })).status).toBe("APPROVED");

    const q = await propose(B, PHONE, "DISMISS_ALERT", { alertId: bAlert });
    await db.whatsappLink.delete({ where: { shop_phone: { shop: B, phone: PHONE } } });
    expect((await decide(PHONE, q.id, "approve")).text).toMatch(/not found/);
    expect((await db.alert.findUniqueOrThrow({ where: { id: bAlert } })).status).toBe("OPEN");
    // Store A is still connected.
    expect((await activeLink(PHONE))?.shop).toBe(A);
  });
});

describe("uninstalled stores", () => {
  it("a request for a store that uninstalled cannot be approved", async () => {
    const aAlert = (await db.alert.findFirstOrThrow({ where: { shop: A, status: "OPEN" } })).id;
    const p = await propose(A, PHONE, "DISMISS_ALERT", { alertId: aAlert });
    await db.shop.update({ where: { id: A }, data: { uninstalledAt: new Date() } });
    expect((await decide(PHONE, p.id, "approve")).text).toMatch(/no longer has the WhatsApp assistant/);
    expect((await db.alert.findUniqueOrThrow({ where: { id: aAlert } })).status).toBe("OPEN");
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("CANCELLED");
    await db.shop.update({ where: { id: A }, data: { uninstalledAt: null } });
  });
});

describe("privacy", () => {
  it("shop/redact deletes one store completely and nothing of the other", async () => {
    const before = await counts(A);
    const { deleteShopData } = await import("./shop-data.server");
    await deleteShopData(B);
    expect(await counts(B)).toEqual({ variants: 0, forecasts: 0, suppliers: 0, pos: 0, alerts: 0, sales: 0 });
    expect(await db.pendingAction.count({ where: { shop: B } })).toBe(0);
    expect(await db.askThread.count({ where: { shop: B } })).toBe(0);
    expect(await db.shop.count({ where: { id: B } })).toBe(0);
    expect(await counts(A)).toEqual(before);
    expect(await db.whatsappLink.count({ where: { shop: A } })).toBe(1);
  });
});
