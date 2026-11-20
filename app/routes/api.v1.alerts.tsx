import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { apiJson, authenticateApi } from "../lib/api/auth.server";
import { serializeAlert } from "../lib/api/serialize.server";

// GET /api/v1/alerts?status=OPEN&type=STOCKOUT_RISK
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "OPEN";
  const type = url.searchParams.get("type");
  const rows = await db.alert.findMany({
    where: { shop: ctx.shop, ...(status !== "ALL" ? { status } : {}), ...(type ? { type } : {}) },
    orderBy: [{ revenueAtRisk: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  return apiJson(ctx, { data: rows.map(serializeAlert) });
};
