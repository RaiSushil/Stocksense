import db from "../../db.server";
import { shortId, variantLabel } from "../format";

export async function serializeForecasts(rows: any[], includeSeries = false) {
  const variants = new Map(
    (await db.variant.findMany({ where: { id: { in: rows.map((r) => r.variantId) } } })).map((v) => [v.id, v]),
  );
  return rows.map((f) => {
    const v = variants.get(f.variantId);
    return {
      variant_id: shortId(f.variantId),
      variant_gid: f.variantId,
      location_id: f.locationId ? shortId(f.locationId) : null,
      title: v ? variantLabel(v) : null,
      sku: v?.sku ?? null,
      vendor: v?.vendor ?? null,
      status: f.status,
      confidence: f.confidence,
      method: f.method,
      on_hand: f.onHand,
      on_order: f.onOrder,
      daily_rate_14d: f.dailyRate14,
      forecast_daily_30d: f.meanDaily,
      days_of_cover: f.daysOfCover,
      stockout_date: f.stockoutDate,
      lead_time_days: f.leadTimeDays,
      safety_stock: f.safetyStock,
      reorder_point: f.reorderPoint,
      suggested_order_qty: f.suggestedQty,
      revenue_at_risk: f.revenueAtRisk,
      overstock_units: f.overstockUnits,
      overstock_value: f.overstockValue,
      accuracy: f.accuracy,
      computed_at: f.computedAt,
      ...(includeSeries
        ? { forecast: JSON.parse(f.series), forecast_low_80: JSON.parse(f.lower), forecast_high_80: JSON.parse(f.upper) }
        : {}),
    };
  });
}

export function serializeAlert(a: any) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    title: a.title,
    message: a.message,
    revenue_at_risk: a.revenueAtRisk,
    variant_id: a.variantId ? shortId(a.variantId) : null,
    supplier_id: a.supplierId,
    location_id: a.locationId ? shortId(a.locationId) : null,
    purchase_order_id: a.poId,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    resolved_at: a.resolvedAt,
  };
}
