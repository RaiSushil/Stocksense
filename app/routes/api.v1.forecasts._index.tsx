import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { apiJson, authenticateApi } from "../lib/api/auth.server";
import { serializeForecasts } from "../lib/api/serialize.server";

// GET /api/v1/forecasts?status=REORDER_NOW&location_id=123&limit=100&page=1
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const location = url.searchParams.get("location_id");
  const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const where = {
    shop: ctx.shop,
    locationId: location ? `gid://shopify/Location/${location}` : "",
    ...(status ? { status } : {}),
  };
  const [rows, total] = await Promise.all([
    db.forecast.findMany({ where, orderBy: [{ revenueAtRisk: "desc" }, { daysOfCover: "asc" }], take: limit, skip: (page - 1) * limit }),
    db.forecast.count({ where }),
  ]);
  return apiJson(ctx, { data: await serializeForecasts(rows), page, limit, total });
};
