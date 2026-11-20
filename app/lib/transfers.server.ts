// Transfer suggestions (Pro): move surplus from a location with too much cover to a
// location that is about to run short, before paying for a new purchase order.

import crypto from "node:crypto";
import db from "../db.server";
import { variantLabel } from "./format";
import { gql, type AdminClient } from "./shopify/admin.server";

export interface TransferSuggestion {
  variantId: string;
  label: string;
  sku: string | null;
  fromLocationId: string;
  fromName: string;
  toLocationId: string;
  toName: string;
  quantity: number;
  toCover: number;
  fromCover: number;
  revenueAtRisk: number;
}

export async function transferSuggestions(shop: string): Promise<TransferSuggestion[]> {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const rows = await db.forecast.findMany({ where: { shop, locationId: { not: "" } } });
  const locations = new Map((await db.location.findMany({ where: { shop } })).map((l) => [l.id, l.name]));
  const byVariant = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byVariant.get(r.variantId) ?? [];
    arr.push(r);
    byVariant.set(r.variantId, arr);
  }
  const variants = new Map(
    (await db.variant.findMany({ where: { id: { in: [...byVariant.keys()] } } })).map((v) => [v.id, v]),
  );

  const out: TransferSuggestion[] = [];
  for (const [variantId, locs] of byVariant) {
    const short = locs.filter((l) => l.status === "REORDER_NOW" || l.status === "WATCH").sort((a, b) => a.daysOfCover - b.daysOfCover);
    const surplus = locs
      .map((l) => ({
        row: l,
        spare: Math.floor(l.onHand - l.meanDaily * (l.leadTimeDays + shopRow.coverageDays) - l.safetyStock),
      }))
      .filter((s) => s.spare > 0)
      .sort((a, b) => b.spare - a.spare);
    for (const need of short) {
      const target = Math.ceil(need.meanDaily * (need.leadTimeDays + 14) + need.safetyStock - need.onHand - need.onOrder);
      if (target <= 0) continue;
      const src = surplus.find((s) => s.spare > 0 && s.row.locationId !== need.locationId);
      if (!src) continue;
      const qty = Math.min(target, src.spare);
      src.spare -= qty;
      const v = variants.get(variantId);
      out.push({
        variantId,
        label: v ? variantLabel(v) : variantId,
        sku: v?.sku ?? null,
        fromLocationId: src.row.locationId,
        fromName: locations.get(src.row.locationId) ?? "Location",
        toLocationId: need.locationId,
        toName: locations.get(need.locationId) ?? "Location",
        quantity: qty,
        toCover: need.daysOfCover,
        fromCover: src.row.daysOfCover,
        revenueAtRisk: need.revenueAtRisk,
      });
    }
  }
  return out.sort((a, b) => b.revenueAtRisk - a.revenueAtRisk);
}

/** Create a draft transfer in Shopify for the selected suggestions between two locations. */
export async function createTransfer(
  admin: AdminClient,
  shop: string,
  fromLocationId: string,
  toLocationId: string,
  lines: { variantId: string; quantity: number }[],
) {
  const variants = new Map(
    (await db.variant.findMany({ where: { shop, id: { in: lines.map((l) => l.variantId) } } })).map((v) => [v.id, v]),
  );
  const lineItems = lines
    .filter((l) => variants.get(l.variantId)?.inventoryItemId && l.quantity > 0)
    .map((l) => ({ inventoryItemId: variants.get(l.variantId)!.inventoryItemId, quantity: l.quantity }));
  if (!lineItems.length) throw new Error("Nothing to transfer");
  const data = await gql<any>(
    admin,
    `#graphql
    mutation StockSenseTransfer($input: InventoryTransferCreateInput!, $key: String!) {
      inventoryTransferCreate(input: $input) @idempotent(key: $key) {
        inventoryTransfer { id name }
        userErrors { field message }
      }
    }`,
    {
      key: crypto.randomUUID(),
      input: {
        originLocationId: fromLocationId,
        destinationLocationId: toLocationId,
        lineItems,
        note: "Suggested by StockSense",
        tags: ["stocksense"],
      },
    },
  );
  const errs = data.inventoryTransferCreate.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return data.inventoryTransferCreate.inventoryTransfer as { id: string; name: string };
}
