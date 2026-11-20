// Outbound notifications: email (SMTP), Slack incoming webhooks, SMS and WhatsApp
// (Twilio), and signed webhooks to the merchant's own systems (Pro). Every channel
// fails soft: a broken Slack URL or phone number must never stop a forecast rebuild.

import crypto from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import db from "../db.server";

let transport: Transporter | null | undefined;

function mailer() {
  if (transport !== undefined) return transport;
  transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
  return transport;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: { filename: string; content: string; contentType?: string }[];
}): Promise<boolean> {
  const t = mailer();
  if (!t) {
    console.info(`[stocksense] SMTP_URL not set, email to ${opts.to} skipped: ${opts.subject}`);
    return false;
  }
  try {
    await t.sendMail({ from: process.env.MAIL_FROM ?? "StockSense <alerts@stocksense.app>", ...opts });
    return true;
  } catch (err) {
    console.error("[stocksense] email failed", err);
    return false;
  }
}

export async function sendSlack(url: string, text: string, lines: string[] = []): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${text}*` } },
          ...(lines.length ? [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }] : []),
        ],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[stocksense] slack failed", err);
    return false;
  }
}

// ---------- SMS and WhatsApp ----------
//
// The app owner configures one Twilio account on the server; merchants only enter
// their mobile number. Environment:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_SMS_FROM            sending number (+15551234567) or Messaging Service SID (MG...)
//   TWILIO_WHATSAPP_FROM       WhatsApp sender, e.g. +14155238886 for the Twilio sandbox
//   TWILIO_WHATSAPP_JOIN_CODE  sandbox only: the "join ..." phrase, shown to merchants
//   TWILIO_WHATSAPP_CONTENT_SID optional approved template (one variable, {{1}}) for
//                              messages outside WhatsApp's 24-hour reply window

export interface SendResult {
  ok: boolean;
  error?: string;
}

export function phoneChannels() {
  const account = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;
  const meta = !!process.env.META_WA_TOKEN && !!process.env.META_WA_PHONE_NUMBER_ID;
  const whatsapp = (account && !!process.env.TWILIO_WHATSAPP_FROM) || meta;
  // Twilio's WhatsApp sandbox only delivers to numbers that sent it the join code first.
  const join = process.env.TWILIO_WHATSAPP_JOIN_CODE;
  const sender = (process.env.TWILIO_WHATSAPP_FROM ?? "").replace(/^whatsapp:/, "");
  return {
    sms: account && !!process.env.TWILIO_SMS_FROM,
    whatsapp,
    whatsappJoin: whatsapp && !meta && join ? { number: sender, code: join, link: `https://wa.me/${sender.replace(/\D/g, "")}?text=${encodeURIComponent(join)}` } : null,
  };
}

/** Normalises a mobile number to E.164 (+ and 8 to 15 digits). Returns null when it is not one. */
export function normalisePhone(input: string): string | null {
  const raw = input.trim().replace(/[\s().-]/g, "");
  const withPlus = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

/** Sends one Twilio message (SMS or WhatsApp) with the server's account. */
export async function twilio(params: Record<string, string>): Promise<SendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { ok: false, error: "not switched on for this app yet" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: number };
    return { ok: false, error: body.message ? `${body.message}${body.code ? ` (Twilio ${body.code})` : ""}` : `Twilio returned ${res.status}` };
  } catch (err) {
    console.error("[stocksense] twilio failed", err);
    return { ok: false, error: "Could not reach Twilio" };
  }
}

export async function sendSms(to: string, text: string): Promise<SendResult> {
  const from = process.env.TWILIO_SMS_FROM;
  if (!from) return { ok: false, error: "not switched on for this app yet" };
  return twilio({ To: to, Body: text.slice(0, 1500), ...(from.startsWith("MG") ? { MessagingServiceSid: from } : { From: from }) });
}

export async function sendWhatsapp(to: string, text: string): Promise<SendResult> {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) return { ok: false, error: "not switched on for this app yet" };
  const template = process.env.TWILIO_WHATSAPP_CONTENT_SID;
  const params: Record<string, string> = { To: `whatsapp:${to}`, From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}` };
  if (template) {
    params.ContentSid = template;
    params.ContentVariables = JSON.stringify({ "1": text.slice(0, 1000) });
  } else {
    params.Body = text.slice(0, 1500);
  }
  return twilio(params);
}

export function signPayload(secret: string, body: string, timestamp: number) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Deliver an event to every active endpoint subscribed to it. */
export async function deliverWebhooks(shop: string, event: string, payload: unknown) {
  const endpoints = await db.webhookEndpoint.findMany({ where: { shop, active: true } });
  await Promise.all(
    endpoints
      .filter((e) => e.events === "*" || e.events.split(",").map((s) => s.trim()).includes(event))
      .map(async (e) => {
        const body = JSON.stringify({ event, shop, sentAt: new Date().toISOString(), data: payload });
        const ts = Math.floor(Date.now() / 1000);
        let status = 0;
        try {
          const res = await fetch(e.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-StockSense-Event": event,
              "X-StockSense-Timestamp": String(ts),
              "X-StockSense-Signature": `sha256=${signPayload(e.secret, body, ts)}`,
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          status = res.status;
        } catch {
          status = 0;
        }
        await db.webhookEndpoint.update({ where: { id: e.id }, data: { lastStatus: status, lastSentAt: new Date() } });
      }),
  );
}

export function appUrl(path = "") {
  return `${process.env.SHOPIFY_APP_URL ?? ""}${path}`;
}

export function adminAppUrl(shop: string, path = "") {
  const handle = process.env.SHOPIFY_APP_HANDLE ?? "stocksense";
  const store = shop.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/apps/${handle}${path}`;
}
