import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { toCsv, variantLabel } from "../lib/format";
import { hasFeature } from "../lib/plans";

// CSV export of every forecast (all plans include CSV export).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  if (!hasFeature(shop.plan, "csvExport")) return new Response("Not available on this plan", { status: 403 });
  const location = new URL(request.url).searchParams.get("location") ?? "";
  const rows = await db.forecast.findMany({ where: { shop: shop.id, locationId: location }, orderBy: { revenueAtRisk: "desc" } });
  const variants = new Map((await db.variant.findMany({ where: { shop: shop.id } })).map((v) => [v.id, v]));
  const suppliers = new Map((await db.supplier.findMany({ where: { shop: shop.id } })).map((s) => [s.id, s.name]));
  const csv = toCsv(
    [
      "Variant ID", "Product", "SKU", "Vendor", "Supplier", "Status", "Confidence", "On hand", "On order",
      "Daily rate (14d)", "Forecast per day (30d)", "Days of cover", "Stockout date", "Lead time (days)",
      "Safety stock", "Reorder point", "Suggested order", "Revenue at risk", "Overstock units", "Overstock value", "Accuracy",
    ],
    rows.map((r) => {
      const v = variants.get(r.variantId);
      return [
        r.variantId.split("/").pop(), v ? variantLabel(v) : "", v?.sku ?? "", v?.vendor ?? "",
        v?.supplierId ? suppliers.get(v.supplierId) ?? "" : "", r.status, r.confidence, r.onHand, r.onOrder,
        r.dailyRate14, r.meanDaily, r.daysOfCover, r.stockoutDate ?? "", r.leadTimeDays, Math.round(r.safetyStock),
        Math.round(r.reorderPoint), r.suggestedQty, r.revenueAtRisk, Math.round(r.overstockUnits), r.overstockValue,
        r.accuracy !== null ? (r.accuracy * 100).toFixed(1) : "",
      ];
    }),
  );
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="stocksense-forecasts.csv"' },
  });
};
