import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { apiError, apiJson, authenticateApi } from "../lib/api/auth.server";
import { leadTimeStats, setSupplierLeadTime } from "../lib/suppliers.server";

// GET  /api/v1/suppliers
// POST /api/v1/suppliers  { id?, name, email?, lead_time_days? }  (creates, or updates when id is given)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const suppliers = await db.supplier.findMany({ where: { shop: ctx.shop }, orderBy: { name: "asc" } });
  const stats = await leadTimeStats(ctx.shop);
  return apiJson(ctx, {
    data: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      contact_name: s.contactName,
      default_lead_time_days: s.defaultLeadTimeDays,
      lead_time_days_90d: stats.get(s.id)?.effective ?? s.defaultLeadTimeDays,
      lead_time_observations: stats.get(s.id)?.observations ?? 0,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const body = await request.json().catch(() => null);
  if (!body?.name && !body?.id) throw apiError(422, "name is required.", ctx.rateHeaders);
  if (ctx.sandbox) return apiJson(ctx, { data: { sandbox: true, ...body } }, body.id ? 200 : 201);
  if (body.id) {
    const s = await db.supplier.findFirst({ where: { id: body.id, shop: ctx.shop } });
    if (!s) throw apiError(404, "Supplier not found.", ctx.rateHeaders);
    await db.supplier.update({
      where: { id: s.id },
      data: { name: body.name ?? s.name, email: body.email ?? s.email, contactName: body.contact_name ?? s.contactName },
    });
    if (Number.isFinite(Number(body.lead_time_days))) await setSupplierLeadTime(ctx.shop, s.id, Number(body.lead_time_days));
    return apiJson(ctx, { data: { id: s.id } });
  }
  const created = await db.supplier.create({
    data: {
      shop: ctx.shop,
      name: String(body.name),
      email: body.email ?? null,
      contactName: body.contact_name ?? null,
      defaultLeadTimeDays: Number.isFinite(Number(body.lead_time_days)) ? Number(body.lead_time_days) : 14,
    },
  });
  return apiJson(ctx, { data: { id: created.id } }, 201);
};
