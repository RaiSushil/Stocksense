import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { apiError, apiJson, authenticateApi, variantGid } from "../lib/api/auth.server";
import { serializeForecasts } from "../lib/api/serialize.server";

// GET /api/v1/forecasts/:variantId  (includes the daily forecast series and 80% band)
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await authenticateApi(request);
  const rows = await db.forecast.findMany({
    where: { shop: ctx.shop, variantId: variantGid(params.variantId!) },
    orderBy: { locationId: "asc" },
  });
  if (!rows.length) throw apiError(404, "No forecast for that variant.", ctx.rateHeaders);
  const [all, ...locations] = await serializeForecasts(rows, true);
  return apiJson(ctx, { data: { ...all, locations } });
};
