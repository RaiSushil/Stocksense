import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { apiError, apiJson, authenticateApi, variantGid } from "../lib/api/auth.server";
import { createDraftPo, poPayload } from "../lib/po.server";

// GET  /api/v1/purchase-orders?status=APPROVED
// POST /api/v1/purchase-orders  { supplier_id, location_id?, notes?, lines: [{ variant_id, quantity, unit_cost? }] }
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const status = new URL(request.url).searchParams.get("status");
  const pos = await db.purchaseOrder.findMany({
    where: { shop: ctx.shop, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true },
  });
  return apiJson(ctx, { data: await Promise.all(pos.map((p) => poPayload(p.id))) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await authenticateApi(request);
  if (request.method !== "POST") throw apiError(405, "Use POST to create a purchase order.", ctx.rateHeaders);
  const body = await request.json().catch(() => null);
  if (!body?.supplier_id || !Array.isArray(body.lines) || !body.lines.length) {
    throw apiError(422, "supplier_id and a non-empty lines array are required.", ctx.rateHeaders);
  }
  const supplier = await db.supplier.findFirst({ where: { id: body.supplier_id, shop: ctx.shop } });
  if (!supplier) throw apiError(404, "Supplier not found.", ctx.rateHeaders);
  const lines = body.lines.map((l: any) => ({
    variantId: variantGid(String(l.variant_id)),
    quantity: Number(l.quantity),
    unitCost: l.unit_cost !== undefined ? Number(l.unit_cost) : undefined,
  }));
  if (lines.some((l: any) => !Number.isFinite(l.quantity) || l.quantity <= 0)) {
    throw apiError(422, "Every line needs a positive quantity.", ctx.rateHeaders);
  }
  if (ctx.sandbox) {
    return apiJson(ctx, { data: { sandbox: true, status: "DRAFT", supplier_id: supplier.id, lines } }, 201);
  }
  try {
    const po = await createDraftPo(ctx.shop, {
      supplierId: supplier.id,
      lines,
      source: "API",
      notes: body.notes,
      locationId: body.location_id ? `gid://shopify/Location/${body.location_id}` : undefined,
    });
    return apiJson(ctx, { data: await poPayload(po.id) }, 201);
  } catch (err) {
    throw apiError(422, err instanceof Error ? err.message : "Could not create purchase order.", ctx.rateHeaders);
  }
};
