// Charts for WhatsApp: drawn as SVG on the server, turned into PNG images and served
// from an unguessable URL for an hour, because WhatsApp can only show pictures.

import crypto from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import db from "../../db.server";
import { addDays, shortDate } from "../dates";
import type { StockCurve } from "../curve.server";

const W = 900;
const H = 480;
const PAD = { l: 84, r: 30, t: 110, b: 70 };
const INK = "#1d1712";
const MUTED = "#8a7d70";
const GRID = "#eee6dc";
const ACCENT = "#f06a1e";
const COLORS = [ACCENT, "#2c6db5", "#2f8a4f", "#a86a00"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A top value that splits into four round gridline steps. */
function niceMax(v: number) {
  if (v <= 0) return 4;
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((s) => s >= raw)!;
  return Math.max(4, step * 4);
}

function frame(title: string, subtitle: string, maxY: number, unit: string) {
  const plotH = H - PAD.t - PAD.b;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = PAD.t + plotH * (1 - f);
    return `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" stroke="${GRID}"/><text x="${PAD.l - 10}" y="${y + 4}" text-anchor="end" font-size="19" fill="${MUTED}">${Math.round(maxY * f)}</text>`;
  });
  return `<rect width="${W}" height="${H}" fill="#fffaf5"/>
<text x="28" y="46" font-size="32" font-weight="700" fill="${INK}">${esc(title)}</text>
<text x="28" y="80" font-size="22" fill="${MUTED}">${esc(subtitle)}${unit ? ` · ${esc(unit)}` : ""}</text>
${ticks.join("")}`;
}

function wrap(body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, DejaVu Sans, Arial, sans-serif">${body}</svg>`;
}

/** Bar or line chart of one or more series. */
export function seriesSvg(spec: { type: "bar" | "line"; title?: string; unit?: string; labels: string[]; series: { name: string; values: number[] }[] }) {
  const n = spec.labels.length;
  const maxY = niceMax(Math.max(1, ...spec.series.flatMap((s) => s.values)));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const slot = plotW / Math.max(1, n);
  const y = (v: number) => PAD.t + plotH * (1 - v / maxY);
  let marks = "";
  if (spec.type === "bar") {
    const bw = Math.min(56, (slot * 0.72) / spec.series.length);
    spec.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = PAD.l + slot * i + (slot - bw * spec.series.length) / 2 + bw * si;
        marks += `<rect x="${x}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, PAD.t + plotH - y(v))}" rx="4" fill="${COLORS[si % COLORS.length]}"/>`;
        if (n <= 12) marks += `<text x="${x + bw / 2 - 1}" y="${y(v) - 6}" text-anchor="middle" font-size="18" fill="${INK}">${Math.round(v * 10) / 10}</text>`;
      });
    });
  } else {
    spec.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${PAD.l + slot * i + slot / 2},${y(v)}`).join(" ");
      marks += `<polyline points="${pts}" fill="none" stroke="${COLORS[si % COLORS.length]}" stroke-width="3" stroke-linejoin="round"/>`;
    });
  }
  const step = Math.max(1, Math.ceil(n / 8));
  const maxChars = Math.max(4, Math.floor((slot * step) / 11));
  const labels = spec.labels
    .map((l, i) =>
      i % step === 0 ? `<text x="${PAD.l + slot * i + slot / 2}" y="${H - PAD.b + 30}" text-anchor="middle" font-size="19" fill="${MUTED}">${esc(l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l)}</text>` : "",
    )
    .join("");
  const legend =
    spec.series.length > 1
      ? spec.series.map((s, si) => `<rect x="${W - PAD.r - 260}" y="${24 + si * 28}" width="16" height="16" rx="4" fill="${COLORS[si % COLORS.length]}"/><text x="${W - PAD.r - 236}" y="${38 + si * 28}" font-size="19" fill="${INK}">${esc(s.name)}</text>`).join("")
      : "";
  return wrap(frame(spec.title ?? "", spec.series.map((s) => s.name).join(" vs "), maxY, spec.unit ?? "") + marks + labels + legend);
}

type StockChartInput = Pick<StockCurve, "label" | "past" | "future" | "futureLow" | "futureHigh" | "reorderPoint" | "leadTimeDay" | "zeroDay" | "today"> & { onHand?: number };

/** Past and projected stock with the forecast range, reorder point, today and order arrival. */
export function stockSvg(c: StockChartInput) {
  const past = c.past;
  const future = c.future;
  const n = past.length + future.length;
  const maxY = niceMax(Math.max(c.reorderPoint, ...past, ...c.futureHigh, 1) * 1.05);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (plotW * i) / Math.max(1, n - 1);
  const y = (v: number) => PAD.t + plotH * (1 - Math.max(0, v) / maxY);
  const p0 = past.length - 1; // today
  const pastPts = past.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const futPts = [`${x(p0)},${y(past[p0] ?? c.onHand ?? 0)}`, ...future.map((v, i) => `${x(p0 + 1 + i)},${y(v)}`)].join(" ");
  const band =
    future.length > 1
      ? `<polygon points="${[...c.futureHigh.map((v, i) => `${x(p0 + 1 + i)},${y(v)}`), ...c.futureLow.map((v, i) => `${x(p0 + 1 + i)},${y(v)}`).reverse()].join(" ")}" fill="${ACCENT}" fill-opacity="0.12"/>`
      : "";
  const rp = `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(c.reorderPoint)}" y2="${y(c.reorderPoint)}" stroke="#c0392b" stroke-dasharray="6 6"/><text x="${PAD.l + 8}" y="${y(c.reorderPoint) - 8}" font-size="18" fill="#c0392b">reorder point ${Math.round(c.reorderPoint)}</text>`;
  const todayLine = `<line x1="${x(p0)}" x2="${x(p0)}" y1="${PAD.t}" y2="${PAD.t + plotH}" stroke="${INK}" stroke-opacity="0.35"/><text x="${x(p0) + 6}" y="${PAD.t + 20}" font-size="18" fill="${INK}">today</text>`;
  const lt = p0 + c.leadTimeDay;
  const ltLine =
    lt < n
      ? `<line x1="${x(lt)}" x2="${x(lt)}" y1="${PAD.t}" y2="${PAD.t + plotH}" stroke="#2c6db5" stroke-dasharray="4 5"/><text x="${x(lt) - 6}" y="${PAD.t + plotH - 10}" text-anchor="end" font-size="18" fill="#2c6db5">order lands</text>`
      : "";
  const step = Math.max(1, Math.ceil(n / 6));
  const labels = Array.from({ length: n }, (_, i) =>
    i % step === 0 ? `<text x="${x(i)}" y="${H - PAD.b + 30}" text-anchor="middle" font-size="19" fill="${MUTED}">${shortDate(addDays(c.today, i - p0))}</text>` : "",
  ).join("");
  const sub = c.zeroDay !== null ? `Runs out around ${shortDate(addDays(c.today, Math.floor(c.zeroDay)))}` : "Stock lasts beyond this window";
  return wrap(
    frame(c.label, sub, maxY, "units on hand") +
      band +
      rp +
      todayLine +
      ltLine +
      `<polyline points="${pastPts}" fill="none" stroke="${INK}" stroke-width="4"/><polyline points="${futPts}" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-dasharray="2 0"/>` +
      labels,
  );
}

export function renderPng(svg: string): Buffer {
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" }, fitTo: { mode: "width", value: W } }).render().asPng();
}

/** Stores the image and returns a public URL valid for an hour. */
export async function publishImage(shop: string, png: Buffer): Promise<string> {
  const id = `${crypto.randomBytes(18).toString("base64url")}.png`;
  await db.whatsappMedia.create({ data: { id, shop, mime: "image/png", data: new Uint8Array(png), expiresAt: new Date(Date.now() + 3_600_000) } });
  // Old images are cleaned up as new ones are made.
  await db.whatsappMedia.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return `${(process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "")}/whatsapp/media/${id}`;
}
