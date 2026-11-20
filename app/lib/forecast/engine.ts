// Demand forecasting for a single variant.
//
// Each variant gets its own curve built from its own history:
//   1. Promotion days are detected from history and normalised out, so a past sale
//      does not inflate the baseline. Planned promotions are added back as uplift.
//   2. Day-of-week and month-of-year indices capture weekly and yearly seasonality,
//      shrunk toward 1 when there is little data to support them.
//   3. A damped Holt (level + trend) model runs on weekly totals of the
//      deseasonalised series; weekly buckets keep daily noise from driving the trend.
//   4. Slow, intermittent sellers use Croston (SBA) instead, which handles long runs
//      of zero-sale days far better than smoothing.
//   5. Every forecast carries an 80% band from the model's own one-step errors, and a
//      backtest over the last four weeks produces the accuracy figure.

import { addDays, monthOf, weekday } from "../dates";
import { clamp, mean, std, sum } from "./stats";

export type ForecastMethod = "HOLT_SEASONAL" | "CROSTON" | "NAIVE" | "NO_DATA";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface ForecastInput {
  /** Daily units sold, oldest first. The last element is the most recent full day. */
  history: number[];
  /** Date (YYYY-MM-DD) of history[0]. */
  historyStart: string;
  /** Optional: true on days that were promotion days (detected from discounts). */
  promoDays?: boolean[];
  /** Optional: multiplier for each future day (1 = no promotion). */
  futureUplift?: number[];
  /** Days to forecast, starting the day after the last history day. */
  horizon: number;
  /** Skip the accuracy backtest (used internally by the backtest itself). */
  skipBacktest?: boolean;
}

export interface ForecastResult {
  method: ForecastMethod;
  mean: number[];
  lower: number[];
  upper: number[];
  sigmaDaily: number;
  dailyRate14: number;
  meanDaily: number;
  historyDays: number;
  accuracy: number | null;
  confidence: Confidence;
}

const Z80 = 1.2816;

export function forecastDemand(input: ForecastInput): ForecastResult {
  const horizon = Math.max(1, input.horizon);
  const uplift = Array.from({ length: horizon }, (_, i) => input.futureUplift?.[i] ?? 1);

  // Ignore the period before the variant first sold: zeros there are not demand.
  const firstSale = input.history.findIndex((u) => u > 0);
  if (firstSale === -1) {
    return emptyResult(horizon, input.history.length);
  }
  const history = input.history.slice(firstSale).map((u) => Math.max(0, u));
  const promo = (input.promoDays ?? []).slice(firstSale);
  const start = addDays(input.historyStart, firstSale);
  const n = history.length;
  const lastDay = addDays(start, n - 1);
  const futureDays = Array.from({ length: horizon }, (_, i) => addDays(lastDay, i + 1));
  const dailyRate14 = mean(history.slice(-14));

  let base: { method: ForecastMethod; mean: number[]; sigma: number };
  const recent = history.slice(-90);
  const zeroShare = recent.filter((u) => u === 0).length / recent.length;

  if (n < 14) {
    const m = mean(history);
    base = { method: "NAIVE", mean: futureDays.map(() => m), sigma: Math.max(Math.sqrt(m), std(history)) };
  } else if (zeroShare > 0.6 && mean(recent) < 1) {
    base = croston(history, horizon);
  } else {
    base = holtSeasonal(history, promo, start, futureDays);
  }

  const meanSeries = base.mean.map((m, i) => Math.max(0, m * uplift[i]));
  const sigma = base.sigma;
  const lower: number[] = [];
  const upper: number[] = [];
  meanSeries.forEach((m, i) => {
    // Uncertainty widens slowly with the horizon.
    const width = Z80 * sigma * Math.sqrt(1 + i / 60) * Math.max(uplift[i], 1);
    lower.push(Math.max(0, m - width));
    upper.push(m + width);
  });

  let accuracy: number | null = null;
  if (!input.skipBacktest && n >= 84) {
    accuracy = backtest(input.history, input.historyStart, input.promoDays);
  }

  const meanDaily = mean(meanSeries.slice(0, 30));
  return {
    method: base.method,
    mean: meanSeries,
    lower,
    upper,
    sigmaDaily: sigma,
    dailyRate14,
    meanDaily,
    historyDays: n,
    accuracy,
    confidence: confidenceFor(base.method, n, accuracy),
  };
}

function emptyResult(horizon: number, historyDays: number): ForecastResult {
  const zeros = Array.from({ length: horizon }, () => 0);
  return {
    method: "NO_DATA",
    mean: zeros,
    lower: zeros,
    upper: zeros,
    sigmaDaily: 0,
    dailyRate14: 0,
    meanDaily: 0,
    historyDays: 0,
    accuracy: null,
    confidence: historyDays > 0 ? "LOW" : "LOW",
  };
}

function confidenceFor(method: ForecastMethod, days: number, accuracy: number | null): Confidence {
  if (method === "NAIVE" || method === "NO_DATA" || days < 60) return "LOW";
  if (accuracy !== null && accuracy < 0.6) return "LOW";
  if (days >= 365 && (accuracy ?? 0) >= 0.85) return "HIGH";
  return "MEDIUM";
}

/** Croston's method with the Syntetos-Boylan bias correction, for intermittent demand. */
function croston(history: number[], horizon: number) {
  const alpha = 0.1;
  let z = 0; // smoothed demand size
  let p = 0; // smoothed interval between demands
  let q = 1;
  let init = false;
  for (const x of history) {
    if (x > 0) {
      if (!init) {
        z = x;
        p = q;
        init = true;
      } else {
        z = z + alpha * (x - z);
        p = p + alpha * (q - p);
      }
      q = 1;
    } else {
      q += 1;
    }
  }
  const rate = init ? (1 - alpha / 2) * (z / Math.max(p, 1)) : 0;
  const recent = history.slice(-90);
  const sigma = Math.sqrt(mean(recent.map((x) => (x - rate) ** 2)));
  return {
    method: "CROSTON" as const,
    mean: Array.from({ length: horizon }, () => rate),
    sigma: Math.max(sigma, Math.sqrt(rate)),
  };
}

function holtSeasonal(history: number[], promo: boolean[], start: string, futureDays: string[]) {
  const n = history.length;
  const days = history.map((_, i) => addDays(start, i));

  // 1. Promotion lift from history. Promo days are scaled down to baseline.
  const window = Math.max(0, n - 365);
  const promoUnits: number[] = [];
  const normalUnits: number[] = [];
  for (let i = window; i < n; i++) (promo[i] ? promoUnits : normalUnits).push(history[i]);
  let lift = 1;
  if (promoUnits.length >= 3 && normalUnits.length >= 14 && mean(normalUnits) > 0) {
    lift = clamp(mean(promoUnits) / mean(normalUnits), 1, 4);
  }
  const adjusted = history.map((u, i) => (promo[i] && lift > 1.05 ? u / lift : u));

  // 2. Seasonality indices.
  const dow = dayOfWeekIndex(adjusted, days);
  const month = n >= 400 ? monthIndex(adjusted, days) : Array.from({ length: 12 }, () => 1);
  const deseasonal = adjusted.map((u, i) => u / (dow[weekday(days[i])] * month[monthOf(days[i])]));

  // 3. Weekly totals, aligned so the last bucket ends on the last history day.
  const weeks: number[] = [];
  for (let end = n; end - 7 >= 0 && weeks.length < 104; end -= 7) {
    weeks.unshift(sum(deseasonal.slice(end - 7, end)));
  }
  if (weeks.length < 3) {
    const m = mean(deseasonal.slice(-14));
    return {
      method: "HOLT_SEASONAL" as const,
      mean: futureDays.map((d) => m * dow[weekday(d)] * month[monthOf(d)]),
      sigma: Math.max(std(adjusted.slice(-28)), Math.sqrt(m)),
    };
  }

  // 4. Damped Holt with a small parameter search on in-sample one-step error.
  let best = { sse: Infinity, level: 0, trend: 0, errors: [] as number[], phi: 0.9 };
  for (const alpha of [0.15, 0.3, 0.5]) {
    for (const beta of [0.05, 0.15]) {
      const fit = dampedHolt(weeks, alpha, beta, 0.9);
      if (fit.sse < best.sse) best = { ...fit, phi: 0.9 };
    }
  }
  const { level, trend, phi } = best;

  const meanSeries = futureDays.map((d, h) => {
    const k = Math.floor(h / 7) + 1;
    let damp = 0;
    for (let i = 1; i <= k; i++) damp += phi ** i;
    const weekly = Math.max(0, level + damp * trend);
    return (weekly / 7) * dow[weekday(d)] * month[monthOf(d)];
  });

  // 5. Daily sigma from weekly one-step errors, with a Poisson floor.
  const errs = best.errors.slice(-26);
  const weeklySigma = errs.length >= 3 ? Math.sqrt(mean(errs.map((e) => e * e))) : std(weeks);
  const dailyMean = mean(meanSeries.slice(0, 28));
  const sigma = Math.max(weeklySigma / Math.sqrt(7), Math.sqrt(dailyMean));
  return { method: "HOLT_SEASONAL" as const, mean: meanSeries, sigma };
}

function dampedHolt(series: number[], alpha: number, beta: number, phi: number) {
  const init = Math.min(4, series.length);
  let level = mean(series.slice(0, init));
  let trend = series.length > init ? (mean(series.slice(init, init * 2)) - level) / init : 0;
  if (!Number.isFinite(trend)) trend = 0;
  let sse = 0;
  const errors: number[] = [];
  for (let t = 1; t < series.length; t++) {
    const forecast = level + phi * trend;
    const err = series[t] - forecast;
    if (t >= init) {
      sse += err * err;
      errors.push(err);
    }
    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  return { sse, level, trend, errors };
}

function dayOfWeekIndex(series: number[], days: string[]): number[] {
  const take = Math.min(series.length, 182);
  const totals = Array.from({ length: 7 }, () => 0);
  const counts = Array.from({ length: 7 }, () => 0);
  for (let i = series.length - take; i < series.length; i++) {
    const w = weekday(days[i]);
    totals[w] += series[i];
    counts[w] += 1;
  }
  const overall = sum(totals) / Math.max(1, sum(counts));
  if (overall <= 0) return Array.from({ length: 7 }, () => 1);
  const weight = clamp(take / 7 / 12, 0, 1); // full weight after ~12 weeks
  const raw = totals.map((t, i) => (counts[i] ? t / counts[i] / overall : 1));
  const shrunk = raw.map((r) => clamp(1 + (r - 1) * weight, 0.2, 3));
  const norm = mean(shrunk);
  return shrunk.map((s) => s / norm);
}

function monthIndex(series: number[], days: string[]): number[] {
  // Use the most recent full year so a growth trend is not mistaken for seasonality.
  const startIdx = series.length - 365;
  const totals = Array.from({ length: 12 }, () => 0);
  const counts = Array.from({ length: 12 }, () => 0);
  for (let i = startIdx; i < series.length; i++) {
    const m = monthOf(days[i]);
    totals[m] += series[i];
    counts[m] += 1;
  }
  const overall = sum(totals) / 365;
  if (overall <= 0) return Array.from({ length: 12 }, () => 1);
  const idx = totals.map((t, i) => (counts[i] ? clamp(1 + (t / counts[i] / overall - 1) * 0.5, 0.4, 2.5) : 1));
  const norm = mean(idx);
  return idx.map((x) => x / norm);
}

/**
 * Fit on everything except the last 28 days, forecast those 28 days and compare
 * weekly totals. Accuracy = 1 - WAPE.
 */
export function backtest(history: number[], historyStart: string, promoDays?: boolean[]): number | null {
  const holdout = 28;
  const train = history.slice(0, -holdout);
  const actual = history.slice(-holdout);
  const actualTotal = sum(actual);
  if (actualTotal <= 0) return null;
  const fit = forecastDemand({
    history: train,
    historyStart,
    promoDays: promoDays?.slice(0, -holdout),
    futureUplift: promoDays?.slice(-holdout).map(() => 1),
    horizon: holdout,
    skipBacktest: true,
  });
  let absErr = 0;
  for (let w = 0; w < 4; w++) {
    const a = sum(actual.slice(w * 7, w * 7 + 7));
    const f = sum(fit.mean.slice(w * 7, w * 7 + 7));
    absErr += Math.abs(a - f);
  }
  return clamp(1 - absErr / actualTotal, 0, 1);
}
