import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { apiError, apiJson, authenticateApi } from "../lib/api/auth.server";
import { approvePo, cancelPo, poPayload, sendPo } from "../lib/po.server";

// GET  /api/v1/purchase-orders/:id
// POST /api/v1/purchase-orders/:id  { "action": "approve" | "send" | "cancel", "email_supplier"?: boolean }
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const po = await db.purchaseOrder.findFirst({ where: { id: params.id, shop: ctx.shop } });
  if (!po) throw apiError(404, "Purchase order not found.", ctx.rateHeaders);
  return apiJson(ctx, { data: await poPayload(po.id) });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const po = await db.purchaseOrder.findFirst({ where: { id: params.id, shop: ctx.shop } });
  if (!po) throw apiError(404, "Purchase order not found.", ctx.rateHeaders);
  const body = await request.json().catch(() => ({}));
  const verb = String(body.action ?? "");
  if (!["approve", "send", "cancel"].includes(verb)) throw apiError(422, "action must be approve, send or cancel.", ctx.rateHeaders);
  if (ctx.sandbox) return apiJson(ctx, { data: { sandbox: true, id: po.id, action: verb } });
  try {
    if (verb === "approve") await approvePo(ctx.shop, po.id);
    if (verb === "send") await sendPo(ctx.shop, po.id, body.email_supplier !== false);
    if (verb === "cancel") await cancelPo(ctx.shop, po.id);
  } catch (err) {
    throw apiError(409, err instanceof Error ? err.message : "Action failed.", ctx.rateHeaders);
  }
  return apiJson(ctx, { data: await poPayload(po.id) });
};
