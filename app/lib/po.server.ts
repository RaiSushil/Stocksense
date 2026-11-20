// Purchase orders. StockSense writes the draft (quantities, supplier, expected date);
// nothing goes to a supplier until a person approves it.

import crypto from "node:crypto";
import db from "../db.server";
import { money, shortId, toCsv, variantLabel } from "./format";
import { hasFeature } from "./plans";
import { gql, type AdminClient } from "./shopify/admin.server";
import { leadTimeStats } from "./suppliers.server";
import { deliverWebhooks, sendEmail } from "./notify.server";

export const OPEN_STATUSES = ["DRAFT", "APPROVED", "SENT", "PARTIAL"];

async function nextNumber(shop: string) {
  const s = await db.shop.update({ where: { id: shop }, data: { nextPoNumber: { increment: 1 } } });
  return `PO-${s.nextPoNumber - 1}`;
}

async function expectedDate(shop: string, supplierId: string) {
  const stats = await leadTimeStats(shop);
  const days = stats.get(supplierId)?.effective ?? 14;
  return new Date(Date.now() + Math.round(days) * 86_400_000);
}

export async function createDraftPo(
  shop: string,
  input: {
    supplierId: string;
    lines: { variantId: string; quantity: number; unitCost?: number }[];
    source: "AUTO" | "ASK" | "MANUAL" | "API";
    locationId?: string | null;
    notes?: string;
  },
) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  await db.supplier.findFirstOrThrow({ where: { id: input.supplierId, shop } });
  const variants = new Map(
    (await db.variant.findMany({ where: { shop, id: { in: input.lines.map((l) => l.variantId) } } })).map((v) => [v.id, v]),
  );
  const lines = input.lines
    .filter((l) => variants.has(l.variantId) && l.quantity > 0)
    .map((l) => ({
      variantId: l.variantId,
      quantity: Math.round(l.quantity),
      unitCost: l.unitCost ?? variants.get(l.variantId)!.unitCost ?? 0,
    }));
  if (!lines.length) throw new Error("A purchase order needs at least one line");
  // A location from another store is ignored; the store's default is used instead.
  const ownLocation = input.locationId ? await db.location.findFirst({ where: { id: input.locationId, shop }, select: { id: true } }) : null;
  const locationId = ownLocation?.id ?? (await defaultLocation(shop));
  return db.purchaseOrder.create({
    data: {
      shop,
      number: await nextNumber(shop),
      supplierId: input.supplierId,
      locationId,
      source: input.source,
      currency: shopRow.currency,
      notes: input.notes,
      expectedAt: await expectedDate(shop, input.supplierId),
      lines: { create: lines },
    },
    include: { lines: true, supplier: true },
  });
}

async function defaultLocation(shop: string) {
  const loc = await db.location.findFirst({ where: { shop, isActive: true }, orderBy: { name: "asc" } });
  return loc?.id ?? null;
}

/**
 * Keep one automatic draft per supplier in line with the latest forecasts: add
 * variants that hit their reorder point, update quantities, drop lines that no
 * longer need ordering. Drafts the merchant created or edited are left alone.
 */
export async function syncAutoDrafts(shop: string) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  if (!hasFeature(shopRow.plan, "draftPurchaseOrders")) return { created: 0, updated: 0 };

  const needs = await db.forecast.findMany({
    where: { shop, locationId: "", status: "REORDER_NOW", suggestedQty: { gt: 0 } },
  });
  const variants = new Map(
    (await db.variant.findMany({ where: { id: { in: needs.map((n) => n.variantId) } } })).map((v) => [v.id, v]),
  );
  // Variants already on an open PO that is not an automatic draft are covered.
  const covered = new Set(
    (
      await db.purchaseOrderLine.findMany({
        where: { po: { shop, status: { in: OPEN_STATUSES }, NOT: { status: "DRAFT", source: "AUTO" } } },
        select: { variantId: true },
      })
    ).map((l) => l.variantId),
  );

  const bySupplier = new Map<string, { variantId: string; quantity: number }[]>();
  for (const n of needs) {
    const v = variants.get(n.variantId);
    if (!v?.supplierId || covered.has(n.variantId)) continue;
    const arr = bySupplier.get(v.supplierId) ?? [];
    arr.push({ variantId: n.variantId, quantity: n.suggestedQty });
    bySupplier.set(v.supplierId, arr);
  }

  const drafts = await db.purchaseOrder.findMany({
    where: { shop, status: "DRAFT", source: "AUTO" },
    include: { lines: true },
  });
  let created = 0;
  let updated = 0;
  for (const [supplierId, lines] of bySupplier) {
    const draft = drafts.find((d) => d.supplierId === supplierId);
    if (!draft) {
      await createDraftPo(shop, { supplierId, lines, source: "AUTO" });
      created++;
      continue;
    }
    const wanted = new Map(lines.map((l) => [l.variantId, l.quantity]));
    await db.$transaction([
      db.purchaseOrderLine.deleteMany({ where: { poId: draft.id, variantId: { notIn: [...wanted.keys()] } } }),
      ...[...wanted].map(([variantId, quantity]) => {
        const line = draft.lines.find((l) => l.variantId === variantId);
        return line
          ? db.purchaseOrderLine.update({ where: { id: line.id }, data: { quantity } })
          : db.purchaseOrderLine.create({
              data: { poId: draft.id, variantId, quantity, unitCost: variants.get(variantId)?.unitCost ?? 0 },
            });
      }),
      db.purchaseOrder.update({ where: { id: draft.id }, data: { expectedAt: await expectedDate(shop, supplierId) } }),
    ]);
    updated++;
  }
  // Automatic drafts for suppliers with nothing left to order are removed.
  const stale = drafts.filter((d) => !bySupplier.has(d.supplierId)).map((d) => d.id);
  if (stale.length) await db.purchaseOrder.deleteMany({ where: { id: { in: stale } } });
  return { created, updated };
}

export async function updatePoLines(shop: string, poId: string, quantities: Record<string, number>, notes?: string) {
  const po = await db.purchaseOrder.findFirstOrThrow({ where: { id: poId, shop }, include: { lines: true } });
  if (po.status !== "DRAFT") throw new Error("Only draft purchase orders can be edited");
  await db.$transaction([
    ...po.lines.map((l) => {
      const q = quantities[l.id];
      if (q === undefined) return db.purchaseOrderLine.findUnique({ where: { id: l.id } });
      return q <= 0
        ? db.purchaseOrderLine.delete({ where: { id: l.id } })
        : db.purchaseOrderLine.update({ where: { id: l.id }, data: { quantity: Math.round(q) } });
    }),
    // Once a person edits an automatic draft it becomes theirs.
    db.purchaseOrder.update({ where: { id: po.id }, data: { source: po.source === "AUTO" ? "MANUAL" : po.source, notes } }),
  ]);
}

export async function approvePo(shop: string, poId: string) {
  const po = await db.purchaseOrder.findFirstOrThrow({ where: { id: poId, shop }, include: { lines: true } });
  if (po.status !== "DRAFT") throw new Error("Only drafts can be approved");
  if (!po.lines.length) throw new Error("This purchase order has no lines");
  const updated = await db.purchaseOrder.update({
    where: { id: po.id },
    data: { status: "APPROVED", approvedAt: new Date(), source: po.source === "AUTO" ? "MANUAL" : po.source },
  });
  // Link open stock alerts to this PO, so the revenue they protect is counted.
  await db.alert.updateMany({
    where: { shop, status: "OPEN", variantId: { in: po.lines.map((l) => l.variantId) }, type: { in: ["STOCKOUT_RISK", "REORDER_POINT", "VELOCITY_SHIFT"] } },
    data: { poId: po.id },
  });
  await deliverWebhooks(shop, "purchase_order.approved", await poPayload(po.id));
  return updated;
}

/** Mark as ordered and email the supplier the PO with a CSV attached. */
export async function sendPo(shop: string, poId: string, emailSupplier: boolean) {
  const po = await db.purchaseOrder.findFirstOrThrow({
    where: { id: poId, shop },
    include: { lines: true, supplier: true },
  });
  if (po.status !== "APPROVED") throw new Error("Approve the purchase order before sending it");
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  let emailed = false;
  if (emailSupplier && po.supplier.email) {
    const csv = await poCsv(shop, po.id);
    const variants = await variantMap(po.lines.map((l) => l.variantId));
    const rows = po.lines
      .map((l) => {
        const v = variants.get(l.variantId);
        return `<tr><td>${v?.sku ?? ""}</td><td>${v ? variantLabel(v) : l.variantId}</td><td style="text-align:right">${l.quantity}</td></tr>`;
      })
      .join("");
    emailed = await sendEmail({
      to: po.supplier.email,
      replyTo: shopRow.email ?? undefined,
      subject: `Purchase order ${po.number} from ${shopRow.name ?? shop}`,
      text: `Please find purchase order ${po.number} attached.${po.expectedAt ? ` Requested delivery: ${po.expectedAt.toDateString()}.` : ""}`,
      html: `<p>Hello${po.supplier.contactName ? ` ${po.supplier.contactName}` : ""},</p><p>Please find purchase order <strong>${po.number}</strong> below.${
        po.expectedAt ? ` Requested delivery: ${po.expectedAt.toDateString()}.` : ""
      }</p><table cellpadding="6" border="1" style="border-collapse:collapse"><tr><th>SKU</th><th>Item</th><th>Qty</th></tr>${rows}</table><p>${shopRow.name ?? shop}</p>`,
      attachments: [{ filename: `${po.number}.csv`, content: csv, contentType: "text/csv" }],
    });
  }
  const updated = await db.purchaseOrder.update({ where: { id: po.id }, data: { status: "SENT", orderedAt: new Date() } });
  await deliverWebhooks(shop, "purchase_order.sent", await poPayload(po.id));
  return { po: updated, emailed };
}

/**
 * Receive stock: adds the received units to Shopify inventory at the PO's location,
 * records the actual supplier lead time and closes the PO when everything arrived.
 */
export async function receivePo(admin: AdminClient, shop: string, poId: string, received: Record<string, number>) {
  const po = await db.purchaseOrder.findFirstOrThrow({ where: { id: poId, shop }, include: { lines: true } });
  if (!["SENT", "APPROVED", "PARTIAL"].includes(po.status)) throw new Error("This purchase order cannot be received");
  if (!po.locationId) throw new Error("Choose a destination location first");
  const variants = await variantMap(po.lines.map((l) => l.variantId));

  const changes = po.lines
    .map((l) => ({ line: l, qty: Math.max(0, Math.round(received[l.id] ?? 0)) }))
    .filter((c) => c.qty > 0 && variants.get(c.line.variantId)?.inventoryItemId);
  if (!changes.length) throw new Error("Enter at least one received quantity");

  const data = await gql<any>(
    admin,
    `#graphql
    mutation StockSenseReceive($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { id }
        userErrors { field message code }
      }
    }`,
    {
      key: crypto.randomUUID(),
      input: {
        name: "available",
        reason: "received",
        referenceDocumentUri: `stocksense://purchase-orders/${po.number}`,
        changes: changes.map((c) => ({
          inventoryItemId: variants.get(c.line.variantId)!.inventoryItemId,
          locationId: po.locationId,
          delta: c.qty,
          // Receiving adds to whatever is on the shelf, so skip the compare-and-swap check.
          changeFromQuantity: null,
        })),
      },
    },
  );
  const errs = data.inventoryAdjustQuantities.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));

  await db.$transaction(
    changes.map((c) =>
      db.purchaseOrderLine.update({ where: { id: c.line.id }, data: { receivedQty: { increment: c.qty } } }),
    ),
  );
  // Keep the local copy in step until the next inventory webhook or sync arrives.
  for (const c of changes) {
    await db.inventoryLevel.upsert({
      where: { variantId_locationId: { variantId: c.line.variantId, locationId: po.locationId } },
      create: { shop, variantId: c.line.variantId, locationId: po.locationId, available: c.qty, onHand: c.qty },
      update: { available: { increment: c.qty }, onHand: { increment: c.qty } },
    });
  }

  const fresh = await db.purchaseOrderLine.findMany({ where: { poId: po.id } });
  const complete = fresh.every((l) => l.receivedQty >= l.quantity);
  const now = new Date();
  await db.purchaseOrder.update({
    where: { id: po.id },
    data: { status: complete ? "RECEIVED" : "PARTIAL", receivedAt: complete ? now : po.receivedAt },
  });
  // The first delivery is when the supplier actually turned the order around.
  if (po.status !== "PARTIAL") {
    const orderedAt = po.orderedAt ?? po.approvedAt ?? po.createdAt;
    const days = Math.max(0, (now.getTime() - orderedAt.getTime()) / 86_400_000);
    await db.leadTimeObservation.create({
      data: { shop, supplierId: po.supplierId, days: Math.round(days * 10) / 10, source: "PO_RECEIVED", poId: po.id },
    });
  }
  await deliverWebhooks(shop, "purchase_order.received", await poPayload(po.id));
  return { complete };
}

export async function cancelPo(shop: string, poId: string) {
  const po = await db.purchaseOrder.findFirstOrThrow({ where: { id: poId, shop } });
  if (["RECEIVED", "CANCELLED"].includes(po.status)) throw new Error("This purchase order is already closed");
  await db.alert.updateMany({ where: { shop, poId: po.id, status: "OPEN" }, data: { poId: null } });
  return db.purchaseOrder.update({ where: { id: po.id }, data: { status: "CANCELLED" } });
}

async function variantMap(ids: string[]) {
  return new Map((await db.variant.findMany({ where: { id: { in: ids } } })).map((v) => [v.id, v]));
}

export async function poCsv(shop: string, poId: string) {
  const po = await db.purchaseOrder.findFirstOrThrow({ where: { id: poId, shop }, include: { lines: true, supplier: true } });
  const variants = await variantMap(po.lines.map((l) => l.variantId));
  return toCsv(
    ["PO", "Supplier", "SKU", "Item", "Quantity", "Unit cost", "Line total", "Received"],
    po.lines.map((l) => {
      const v = variants.get(l.variantId);
      return [po.number, po.supplier.name, v?.sku ?? "", v ? variantLabel(v) : l.variantId, l.quantity, l.unitCost, (l.quantity * l.unitCost).toFixed(2), l.receivedQty];
    }),
  );
}

export async function poPayload(poId: string) {
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true, supplier: true } });
  const variants = await variantMap(po.lines.map((l) => l.variantId));
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    source: po.source,
    supplier: { id: po.supplierId, name: po.supplier.name, email: po.supplier.email },
    locationId: po.locationId,
    currency: po.currency,
    expectedAt: po.expectedAt,
    approvedAt: po.approvedAt,
    orderedAt: po.orderedAt,
    receivedAt: po.receivedAt,
    total: po.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0),
    lines: po.lines.map((l) => {
      const v = variants.get(l.variantId);
      return {
        id: l.id,
        variantId: shortId(l.variantId),
        sku: v?.sku ?? null,
        title: v ? variantLabel(v) : null,
        quantity: l.quantity,
        unitCost: l.unitCost,
        receivedQty: l.receivedQty,
      };
    }),
  };
}

export function poTotal(lines: { quantity: number; unitCost: number }[]) {
  return lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
}

export function poTotalLabel(lines: { quantity: number; unitCost: number }[], currency: string) {
  return money(poTotal(lines), currency);
}
