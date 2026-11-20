import { describe, expect, it } from "vitest";
import { forecastDemand } from "./engine";
import { orderBreakdown, planInventory, projectStock } from "./inventory";
import { inverseNormal, sum } from "./stats";
import { addDays, weekday } from "../dates";

// Deterministic pseudo random so tests are stable.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function poisson(lambda: number, r: () => number) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}

describe("stats", () => {
  it("inverse normal matches known quantiles", () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 6);
    expect(inverseNormal(0.95)).toBeCloseTo(1.6449, 3);
    expect(inverseNormal(0.99)).toBeCloseTo(2.3263, 3);
  });
});

describe("forecastDemand", () => {
  it("returns NO_DATA when nothing ever sold", () => {
    const f = forecastDemand({ history: Array(60).fill(0), historyStart: "2026-01-01", horizon: 30 });
    expect(f.method).toBe("NO_DATA");
    expect(sum(f.mean)).toBe(0);
  });

  it("tracks a steady seller and reports high accuracy", () => {
    const r = rng(1);
    const history = Array.from({ length: 400 }, () => poisson(10, r));
    const f = forecastDemand({ history, historyStart: "2025-01-01", horizon: 60 });
    expect(f.method).toBe("HOLT_SEASONAL");
    expect(f.meanDaily).toBeGreaterThan(8.5);
    expect(f.meanDaily).toBeLessThan(11.5);
    expect(f.accuracy).not.toBeNull();
    expect(f.accuracy!).toBeGreaterThan(0.85);
    expect(f.lower[0]).toBeLessThan(f.mean[0]);
    expect(f.upper[0]).toBeGreaterThan(f.mean[0]);
  });

  it("picks up weekly seasonality", () => {
    const start = "2025-06-02";
    const r = rng(2);
    const history = Array.from({ length: 200 }, (_, i) => {
      const w = weekday(addDays(start, i));
      return poisson(w === 6 || w === 0 ? 20 : 8, r);
    });
    const f = forecastDemand({ history, historyStart: start, horizon: 14 });
    const lastDay = addDays(start, 199);
    const weekend: number[] = [];
    const weekdays: number[] = [];
    f.mean.forEach((m, i) => {
      const w = weekday(addDays(lastDay, i + 1));
      (w === 6 || w === 0 ? weekend : weekdays).push(m);
    });
    expect(sum(weekend) / weekend.length).toBeGreaterThan((sum(weekdays) / weekdays.length) * 1.6);
  });

  it("follows an upward trend", () => {
    const r = rng(3);
    const history = Array.from({ length: 180 }, (_, i) => poisson(2 + i * 0.05, r));
    const f = forecastDemand({ history, historyStart: "2026-01-01", horizon: 28 });
    expect(f.meanDaily).toBeGreaterThan(9);
  });

  it("uses Croston for intermittent demand", () => {
    const r = rng(4);
    const history = Array.from({ length: 180 }, () => (r() < 0.15 ? 2 : 0));
    const f = forecastDemand({ history, historyStart: "2026-01-01", horizon: 30 });
    expect(f.method).toBe("CROSTON");
    expect(f.meanDaily).toBeGreaterThan(0.15);
    expect(f.meanDaily).toBeLessThan(0.5);
  });

  it("removes past promotion spikes from the baseline and applies planned uplift", () => {
    const r = rng(5);
    const promoDays = Array.from({ length: 200 }, (_, i) => i % 30 < 3);
    const history = promoDays.map((p) => poisson(p ? 30 : 10, r));
    const plain = forecastDemand({ history, historyStart: "2026-01-01", horizon: 14 });
    expect(plain.meanDaily).toBeLessThan(12);
    const uplift = Array.from({ length: 14 }, (_, i) => (i < 3 ? 1.5 : 1));
    const promo = forecastDemand({ history, historyStart: "2026-01-01", horizon: 14, futureUplift: uplift });
    expect(promo.mean[0]).toBeCloseTo(plain.mean[0] * 1.5, 5);
  });
});

describe("planInventory", () => {
  const base = {
    sigmaDaily: 1.2,
    leadTimeStdDays: 2,
    serviceLevel: 0.95,
    coverageDays: 60,
    overstockDays: 90,
    price: 68,
    unitCost: 22,
    casePack: 1,
    minOrderQty: 0,
    incoming: [],
  };

  it("flags a fast seller that runs out inside the lead time", () => {
    const res = planInventory({ ...base, mean: Array(120).fill(1.8), onHand: 11, leadTimeDays: 17 });
    expect(res.daysOfCover).toBeCloseTo(11 / 1.8, 1);
    expect(res.status).toBe("REORDER_NOW");
    expect(res.suggestedQty).toBeGreaterThan(130);
    expect(res.revenueAtRisk).toBeGreaterThan(0);
  });

  it("counts incoming purchase orders in cover", () => {
    const res = planInventory({
      ...base,
      mean: Array(120).fill(2),
      onHand: 10,
      leadTimeDays: 10,
      incoming: [{ day: 3, qty: 200 }],
    });
    expect(res.onOrder).toBe(200);
    expect(res.daysOfCover).toBeGreaterThan(100);
    expect(res.status).not.toBe("REORDER_NOW");
  });

  it("rounds the order up to the case pack", () => {
    const res = planInventory({ ...base, casePack: 24, mean: Array(120).fill(3), onHand: 5, leadTimeDays: 14 });
    expect(res.suggestedQty % 24).toBe(0);
  });

  it("marks overstock and values it at cost", () => {
    const res = planInventory({ ...base, mean: Array(120).fill(2), onHand: 1840, leadTimeDays: 14 });
    expect(res.status).toBe("OVERSTOCKED");
    expect(res.overstockValue).toBeGreaterThan(1000 * 22);
  });

  it("treats stock with no demand as dead stock", () => {
    const res = planInventory({ ...base, mean: Array(120).fill(0), onHand: 40, leadTimeDays: 14 });
    expect(res.daysOfCover).toBe(999);
    expect(res.overstockUnits).toBe(40);
  });
});

describe("orderBreakdown", () => {
  const input = {
    mean: Array.from({ length: 120 }, (_, i) => 2 + (i % 7 === 5 ? 1.5 : 0)),
    sigmaDaily: 1.1,
    onHand: 12,
    leadTimeDays: 17,
    leadTimeStdDays: 3,
    serviceLevel: 0.95,
    coverageDays: 30,
    overstockDays: 90,
    price: 30,
    unitCost: 12,
    casePack: 6,
    minOrderQty: 40,
  };

  it("adds up to the same quantity the forecast suggests", () => {
    const plan = planInventory({ ...input, incoming: [{ day: 5, qty: 10 }] });
    const b = orderBreakdown({ ...input, onOrder: 10 });
    expect(plan.suggestedQty).toBeGreaterThan(0);
    expect(b.suggested).toBe(plan.suggestedQty);
    expect(b.target).toBeCloseTo(b.leadTimeDemand + b.coverageDemand + b.safetyStock, 6);
    expect(b.shortfall).toBe(Math.ceil(b.target - 22));
    expect(b.suggested % 6).toBe(0);
    expect(b.suggested).toBeGreaterThanOrEqual(40);
  });

  it("asks for more when the supplier is slower", () => {
    const fast = orderBreakdown({ ...input, onOrder: 0, leadTimeDays: 7, leadTimeStdDays: 1 });
    const slow = orderBreakdown({ ...input, onOrder: 0, leadTimeDays: 30, leadTimeStdDays: 6 });
    expect(slow.suggested).toBeGreaterThan(fast.suggested);
  });

  it("projects the order landing on its day", () => {
    const mean = Array(40).fill(2);
    const without = projectStock(mean, 10, [], 40);
    const withOrder = projectStock(mean, 10, [{ day: 4, qty: 50 }], 40);
    expect(without.stockoutDay).toBe(5);
    expect(withOrder.stockoutDay).toBe(30);
    expect(withOrder.projection[4]).toBe(50);
  });
});
