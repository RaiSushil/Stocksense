// Evaluates alert rules against the latest forecasts, keeps one open alert per
// situation, resolves alerts that no longer apply, and notifies only on new or
// escalated alerts. Alerts are ranked by revenue at risk, not by stock level.

import db from "../../db.server";
import { addDays, todayIn, weekdayName } from "../dates";
import { money, variantLabel } from "../format";
import { hasFeature } from "../plans";
import { leadTimeStats } from "../suppliers.server";
import { adminAppUrl, deliverWebhooks, sendEmail, sendSlack, sendSms } from "../notify.server";
import { sendWhatsappAlert } from "../whatsapp/provider.server";
import {
  ALERT_TYPE_LABEL,
  leadTimeRule,
  stockRules,
  velocityRule,
  type AlertCandidate,
  type ForecastView,
} from "./rules";

interface Options {
  /** Only run the velocity rule for these variants (order webhook path). */
  velocityOnly?: string[];
}

export async function evaluateAlerts(shop: string, opts: Options = {}) {
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const plan = shopRow.plan;
  const fmt = (n: number) => money(n, shopRow.currency);
  const today = todayIn(shopRow.timezone);

  const where = opts.velocityOnly ? { shop, variantId: { in: opts.velocityOnly } } : { shop };
  const forecasts = await db.forecast.findMany({ where });
  const variantIds = [...new Set(forecasts.map((f) => f.variantId))];
  const variants = new Map(
    (await db.variant.findMany({ where: { id: { in: variantIds } } })).map((v) => [v.id, v]),
  );
  const locations = new Map((await db.location.findMany({ where: { shop } })).map((l) => [l.id, l.name]));
  const draftLines = await db.purchaseOrderLine.findMany({
    where: { po: { shop, status: "DRAFT" }, variantId: { in: variantIds } },
    select: { variantId: true },
  });
  const hasDraft = new Set(draftLines.map((l) => l.variantId));

  const views: ForecastView[] = forecasts.map((f) => {
    const v = variants.get(f.variantId);
    const base = v ? variantLabel(v) : f.variantId;
    return {
      variantId: f.variantId,
      locationId: f.locationId,
      label: f.locationId ? `${base} (${locations.get(f.locationId) ?? "location"})` : base,
      onHand: f.onHand,
      onOrder: f.onOrder,
      daysOfCover: f.daysOfCover,
      leadTimeDays: f.leadTimeDays,
      suggestedQty: f.suggestedQty,
      revenueAtRisk: f.revenueAtRisk,
      overstockValue: f.overstockValue,
      status: f.status,
      meanDaily: f.meanDaily,
      sigmaDaily: f.sigmaDaily,
      hasDraftPo: hasDraft.has(f.variantId),
    };
  });

  const candidates: AlertCandidate[] = [];
  const evaluatedTypes = new Set<string>();

  if (!opts.velocityOnly) {
    evaluatedTypes.add("STOCKOUT_RISK").add("REORDER_POINT").add("OVERSTOCK");
    // Store-level alerts only. A shortage at one location while the store as a whole
    // is fine is a transfer, not an alert (see Transfers), so it does not add noise.
    for (const v of views.filter((x) => x.locationId === "")) candidates.push(...stockRules(v, fmt));
  }

  // Velocity: last 3 days including today so far.
  if (hasFeature(plan, "velocityAlerts")) {
    evaluatedTypes.add("VELOCITY_SHIFT");
    const since = addDays(today, -2);
    const baseStart = addDays(today, -30);
    const recent = await db.salesDaily.groupBy({
      by: ["variantId", "date"],
      where: { shop, date: { gte: baseStart }, variantId: { in: variantIds } },
      _sum: { units: true },
    });
    const actual = new Map<string, number>();
    const baseline = new Map<string, number>();
    for (const r of recent) {
      const target = r.date >= since ? actual : baseline;
      target.set(r.variantId, (target.get(r.variantId) ?? 0) + (r._sum.units ?? 0));
    }
    for (const v of views.filter((x) => x.locationId === "")) {
      const c = velocityRule(
        v,
        actual.get(v.variantId) ?? 0,
        // The window is two full days plus today so far.
        ((baseline.get(v.variantId) ?? 0) / 28) * ((2 + dayFraction(shopRow.timezone)) / 3),
        weekdayName(since),
        shopRow.velocityThreshold,
        variants.get(v.variantId)?.price ?? 0,
      );
      if (c) candidates.push(c);
    }
  }

  // Lead time drift per supplier.
  if (!opts.velocityOnly && hasFeature(plan, "leadTimeAlerts")) {
    evaluatedTypes.add("LEAD_TIME_DRIFT");
    const stats = await leadTimeStats(shop);
    const riskBySupplier = new Map<string, number>();
    for (const f of forecasts.filter((x) => x.locationId === "")) {
      const sid = variants.get(f.variantId)?.supplierId;
      if (sid) riskBySupplier.set(sid, (riskBySupplier.get(sid) ?? 0) + f.revenueAtRisk);
    }
    for (const s of stats.values()) {
      // Only recent changes are news.
      if (!s.latestAt || Date.now() - s.latestAt.getTime() > 7 * 86_400_000) continue;
      const c = leadTimeRule(s, riskBySupplier.get(s.supplierId) ?? 0);
      if (c) candidates.push(c);
    }
  }

  // Persist: upsert by dedupe key, resolve what no longer applies.
  const open = await db.alert.findMany({
    where: {
      shop,
      status: { in: ["OPEN", "DISMISSED"] },
      type: { in: [...evaluatedTypes] },
      ...(opts.velocityOnly ? { variantId: { in: opts.velocityOnly } } : {}),
    },
  });
  const openByKey = new Map(open.map((a) => [a.dedupeKey, a]));
  const toNotify: AlertCandidate[] = [];
  const candidateKeys = new Set<string>();

  for (const c of candidates) {
    candidateKeys.add(c.dedupeKey);
    const existing = openByKey.get(c.dedupeKey);
    if (!existing) {
      await db.alert.create({
        data: {
          shop,
          type: c.type,
          severity: c.severity,
          variantId: c.variantId,
          supplierId: c.supplierId,
          locationId: c.locationId,
          title: c.title,
          message: c.message,
          revenueAtRisk: c.revenueAtRisk,
          dedupeKey: c.dedupeKey,
          fingerprint: c.fingerprint,
        },
      });
      toNotify.push(c);
    } else {
      const changed = existing.fingerprint !== c.fingerprint;
      await db.alert.update({
        where: { id: existing.id },
        data: {
          severity: c.severity,
          title: c.title,
          message: c.message,
          revenueAtRisk: c.revenueAtRisk,
          fingerprint: c.fingerprint,
          // A dismissed alert comes back only if the situation changed.
          status: changed ? "OPEN" : existing.status,
        },
      });
      if (changed) toNotify.push(c);
    }
  }

  const stale = open.filter((a) => !candidateKeys.has(a.dedupeKey));
  if (stale.length) {
    await db.alert.updateMany({
      where: { id: { in: stale.map((a) => a.id) } },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }

  if (toNotify.length) await notify(shopRow, toNotify);
  return { candidates: candidates.length, notified: toNotify.length, resolved: stale.length };
}

async function notify(
  shopRow: {
    id: string;
    plan: string;
    currency: string;
    alertEmail: string | null;
    notifyEmail: boolean;
    slackWebhookUrl: string | null;
    notifySlack: boolean;
    name: string | null;
    alertPhone?: string | null;
    notifySms?: boolean;
    notifyWhatsapp?: boolean;
    phoneUrgentOnly?: boolean;
  },
  alerts: AlertCandidate[],
) {
  const sorted = [...alerts].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.revenueAtRisk - a.revenueAtRisk);
  // Overstock is informational; it shows in the app but does not interrupt anyone.
  const interrupting = sorted.filter((a) => a.severity !== "INFO" || a.type === "LEAD_TIME_DRIFT");
  const fmt = (n: number) => money(n, shopRow.currency);
  const line = (a: AlertCandidate) =>
    `${a.title}: ${a.message}${a.revenueAtRisk > 0 ? ` (${fmt(a.revenueAtRisk)} at risk)` : ""}`;
  const link = adminAppUrl(shopRow.id, "/alerts");

  if (interrupting.length && shopRow.notifyEmail && shopRow.alertEmail && hasFeature(shopRow.plan, "emailAlerts")) {
    const subject =
      interrupting.length === 1
        ? `${ALERT_TYPE_LABEL[interrupting[0].type]}: ${interrupting[0].title}`
        : `${interrupting.length} inventory alerts need you`;
    const rows = interrupting
      .map(
        (a) =>
          `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee"><strong>${esc(a.title)}</strong><br><span style="color:#555">${esc(
            a.message,
          )}</span></td><td style="padding:8px 12px;border-bottom:1px solid #eee;white-space:nowrap">${
            a.revenueAtRisk > 0 ? esc(fmt(a.revenueAtRisk)) : ""
          }</td></tr>`,
      )
      .join("");
    await sendEmail({
      to: shopRow.alertEmail,
      subject,
      text: `${interrupting.map(line).join("\n")}\n\nOpen StockSense: ${link}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px"><h2 style="margin:0 0 12px">StockSense alerts for ${esc(
        shopRow.name ?? shopRow.id,
      )}</h2><table style="border-collapse:collapse;width:100%">${rows}</table><p><a href="${link}">Open alerts in StockSense</a></p></div>`,
    });
  }

  if (interrupting.length && shopRow.notifySlack && shopRow.slackWebhookUrl && hasFeature(shopRow.plan, "slackAlerts")) {
    await sendSlack(
      shopRow.slackWebhookUrl,
      `StockSense: ${interrupting.length} new alert${interrupting.length > 1 ? "s" : ""}`,
      [...interrupting.slice(0, 10).map((a) => `• ${line(a)}`), `<${link}|Open StockSense>`],
    );
  }

  // Phone: short and only what needs action today unless the merchant asked for everything.
  if (shopRow.alertPhone && (shopRow.notifySms || shopRow.notifyWhatsapp) && hasFeature(shopRow.plan, "phoneAlerts")) {
    const forPhone = shopRow.phoneUrgentOnly === false ? interrupting : interrupting.filter((a) => URGENT_TYPES.includes(a.type));
    if (forPhone.length) {
      const text = phoneText(shopRow.name ?? shopRow.id, forPhone, fmt, link);
      if (shopRow.notifySms) {
        const r = await sendSms(shopRow.alertPhone, text);
        if (!r.ok) console.warn(`[stocksense] ${shopRow.id}: SMS alert not sent: ${r.error}`);
      }
      if (shopRow.notifyWhatsapp) {
        const r = await sendWhatsappAlert(shopRow.alertPhone, text, shopRow.id);
        if (!r.ok) console.warn(`[stocksense] ${shopRow.id}: WhatsApp alert not sent: ${r.error}`);
      }
    }
  }

  if (hasFeature(shopRow.plan, "api")) {
    for (const a of sorted) {
      await deliverWebhooks(shopRow.id, `alert.${a.type.toLowerCase()}`, a);
    }
  }

  await db.alert.updateMany({
    where: { shop: shopRow.id, dedupeKey: { in: alerts.map((a) => a.dedupeKey) }, status: "OPEN" },
    data: { notifiedAt: new Date() },
  });
}

/** Alert types that go to a phone when "urgent only" is on. */
export const URGENT_TYPES = ["STOCKOUT_RISK", "REORDER_POINT"];

/** A short alert message for SMS and WhatsApp: the top three, then a link. */
export function phoneText(store: string, alerts: AlertCandidate[], fmt: (n: number) => string, link: string) {
  const lines = alerts.slice(0, 3).map((a) => `- ${a.title}: ${a.message}${a.revenueAtRisk > 0 ? ` (${fmt(a.revenueAtRisk)} at risk)` : ""}`);
  const more = alerts.length > 3 ? `\n+${alerts.length - 3} more` : "";
  return `StockSense, ${store}: ${alerts.length} alert${alerts.length === 1 ? "" : "s"}\n${lines.join("\n")}${more}\n${link}`;
}

/** Share of the current day already elapsed in the shop's timezone. */
function dayFraction(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return Math.max(0.05, (h * 60 + m) / 1440);
  } catch {
    return 0.5;
  }
}

function sevRank(s: string) {
  return s === "CRITICAL" ? 0 : s === "WARNING" ? 1 : 2;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
