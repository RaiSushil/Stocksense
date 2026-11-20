// Turns a demand forecast into inventory decisions: days of cover, reorder point,
// safety stock, suggested order quantity, revenue at risk and overstock.
// Cover is counted in days you can actually trade, using the forecast curve and
// the supplier lead time, not units on a shelf.

import { inverseNormal, sum } from "./stats";

export type StockStatus = "REORDER_NOW" | "WATCH" | "HEALTHY" | "OVERSTOCKED" | "NO_DATA";

export interface IncomingStock {
  /** Day index from today (0 = arrives today). */
  day: number;
  qty: number;
}

export interface InventoryInput {
  mean: number[]; // daily forecast, index 0 = today
  sigmaDaily: number;
  onHand: number;
  incoming: IncomingStock[];
  leadTimeDays: number;
  leadTimeStdDays: number;
  serviceLevel: number;
  coverageDays: number;
  overstockDays: number;
  price: number;
  unitCost: number | null;
  casePack: number;
  minOrderQty: number;
}

export interface InventoryResult {
  onOrder: number;
  safetyStock: number;
  reorderPoint: number;
  leadTimeDemand: number;
  daysOfCover: number;
  stockoutDay: number | null;
  suggestedQty: number;
  revenueAtRisk: number;
  lostUnits: number;
  overstockUnits: number;
  overstockValue: number;
  status: StockStatus;
  /** Projected units on hand for each day of the horizon, without a new order. */
  projection: number[];
}

export const MAX_COVER = 999;

export function planInventory(input: InventoryInput): InventoryResult {
  const horizon = input.mean.length;
  const L = Math.max(1, Math.ceil(input.leadTimeDays));
  const demandOver = (days: number) => {
    let s = 0;
    for (let i = 0; i < days; i++) s += input.mean[Math.min(i, horizon - 1)] ?? 0;
    return s;
  };
  const avgDaily = sum(input.mean.slice(0, 30)) / Math.min(30, Math.max(1, horizon));

  const z = inverseNormal(input.serviceLevel);
  const leadTimeDemand = demandOver(L);
  const dAvgL = leadTimeDemand / L;
  const safetyStock = Math.max(
    0,
    z * Math.sqrt(L * input.sigmaDaily ** 2 + dAvgL ** 2 * input.leadTimeStdDays ** 2),
  );
  const reorderPoint = leadTimeDemand + safetyStock;
  const onOrder = sum(input.incoming.map((i) => i.qty));
  const position = input.onHand + onOrder;

  // Project stock forward with incoming purchase orders landing on their expected day.
  const incomingByDay = new Map<number, number>();
  for (const inc of input.incoming) {
    const d = Math.max(0, Math.floor(inc.day));
    incomingByDay.set(d, (incomingByDay.get(d) ?? 0) + inc.qty);
  }
  const projection: number[] = [];
  let stock = input.onHand;
  let stockoutDay: number | null = null;
  let lostUnits = 0;
  const riskWindow = L + 14;
  for (let h = 0; h < horizon; h++) {
    stock += incomingByDay.get(h) ?? 0;
    const demand = input.mean[h];
    if (stock - demand <= 0 && stockoutDay === null && demand > 0) {
      stockoutDay = h + (stock > 0 ? stock / demand : 0);
    }
    if (h < riskWindow) lostUnits += Math.max(0, demand - Math.max(0, stock));
    stock -= demand;
    projection.push(Math.max(0, stock));
  }

  let daysOfCover: number;
  if (avgDaily <= 0) daysOfCover = input.onHand > 0 ? MAX_COVER : 0;
  else if (stockoutDay !== null) daysOfCover = stockoutDay;
  else daysOfCover = Math.min(MAX_COVER, horizon + Math.max(0, stock) / avgDaily);

  // Order when the inventory position can no longer cover lead time demand plus safety
  // stock, or when cover runs out within a week of the lead time.
  const needsOrder = avgDaily > 0 && (position <= reorderPoint || daysOfCover <= L + 7);
  const suggestedQty = needsOrder ? orderBreakdown({ ...input, onOrder }).suggested : 0;

  const overstockUnits =
    avgDaily <= 0
      ? input.onHand
      : Math.max(0, input.onHand - demandOver(input.overstockDays) - safetyStock);
  const unitValue = input.unitCost ?? input.price * 0.5;
  const overstockValue = overstockUnits * unitValue;

  let status: StockStatus;
  if (avgDaily <= 0 && input.onHand <= 0) status = "NO_DATA";
  else if (suggestedQty > 0 && (position <= reorderPoint || daysOfCover <= L)) status = "REORDER_NOW";
  else if (suggestedQty > 0 || daysOfCover <= L + 28) status = "WATCH";
  else if (daysOfCover > input.overstockDays && overstockUnits > 0) status = "OVERSTOCKED";
  else status = "HEALTHY";

  return {
    onOrder,
    safetyStock,
    reorderPoint,
    leadTimeDemand,
    daysOfCover,
    stockoutDay,
    suggestedQty,
    lostUnits,
    revenueAtRisk: lostUnits * input.price,
    overstockUnits,
    overstockValue,
    status,
    projection,
  };
}

export interface OrderInput {
  mean: number[];
  sigmaDaily: number;
  onHand: number;
  onOrder: number;
  leadTimeDays: number;
  leadTimeStdDays: number;
  serviceLevel: number;
  coverageDays: number;
  casePack: number;
  minOrderQty: number;
}

export interface OrderBreakdown {
  leadTimeDays: number;
  /** Forecast units sold while the order is on its way. */
  leadTimeDemand: number;
  /** Forecast units sold in the coverage window after the order lands. */
  coverageDemand: number;
  safetyStock: number;
  /** Stock the order should bring you up to: lead time demand + coverage demand + safety stock. */
  target: number;
  /** On hand plus already on order. */
  position: number;
  /** Units short of the target, before supplier rules. */
  shortfall: number;
  /** Shortfall raised to the minimum order quantity. */
  afterMinimum: number;
  /** Final quantity, rounded up to whole case packs. */
  suggested: number;
  avgDaily: number;
}

/**
 * How many units to order and why. The same arithmetic the forecast uses for its
 * suggested quantity, exposed step by step so the reorder screen can show it and
 * recompute it when the supplier, lead time, coverage or pack size changes.
 */
export function orderBreakdown(input: OrderInput): OrderBreakdown {
  const horizon = input.mean.length;
  const L = Math.max(1, Math.ceil(input.leadTimeDays));
  const demandOver = (from: number, days: number) => {
    let s = 0;
    for (let i = from; i < from + days; i++) s += input.mean[Math.min(i, horizon - 1)] ?? 0;
    return s;
  };
  const leadTimeDemand = demandOver(0, L);
  const coverageDemand = demandOver(L, Math.max(0, Math.round(input.coverageDays)));
  const dAvgL = leadTimeDemand / L;
  const z = inverseNormal(input.serviceLevel);
  const safetyStock = Math.max(0, z * Math.sqrt(L * input.sigmaDaily ** 2 + dAvgL ** 2 * input.leadTimeStdDays ** 2));
  const target = leadTimeDemand + coverageDemand + safetyStock;
  const position = input.onHand + input.onOrder;
  const shortfall = Math.max(0, Math.ceil(target - position));
  const afterMinimum = shortfall > 0 ? Math.max(shortfall, input.minOrderQty) : 0;
  const pack = Math.max(1, input.casePack);
  const suggested = Math.ceil(afterMinimum / pack) * pack;
  const window = Math.max(1, L + Math.round(input.coverageDays));
  return {
    leadTimeDays: L,
    leadTimeDemand,
    coverageDemand,
    safetyStock,
    target,
    position,
    shortfall,
    afterMinimum,
    suggested,
    avgDaily: demandOver(0, window) / window,
  };
}

/**
 * Units on hand for each day ahead, with incoming stock landing on its day.
 * Returns the projection and the first day stock runs out (null if it never does).
 */
export function projectStock(mean: number[], onHand: number, incoming: IncomingStock[], days: number) {
  const byDay = new Map<number, number>();
  for (const inc of incoming) {
    const d = Math.max(0, Math.floor(inc.day));
    byDay.set(d, (byDay.get(d) ?? 0) + inc.qty);
  }
  const out: number[] = [];
  let stock = onHand;
  let stockoutDay: number | null = null;
  for (let h = 0; h < days; h++) {
    stock += byDay.get(h) ?? 0;
    const demand = mean[Math.min(h, mean.length - 1)] ?? 0;
    if (stockoutDay === null && demand > 0 && stock - demand <= 0) stockoutDay = h + (stock > 0 ? stock / demand : 0);
    stock -= demand;
    out.push(Math.max(0, stock));
  }
  return { projection: out, stockoutDay };
}
