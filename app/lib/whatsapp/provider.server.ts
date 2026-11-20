// Sending and receiving WhatsApp messages.
//
// Two providers are supported, chosen from the environment:
//   meta   WhatsApp Cloud API. Real buttons and lists, like a bank's WhatsApp menu.
//          META_WA_TOKEN, META_WA_PHONE_NUMBER_ID, META_WA_APP_SECRET, META_WA_VERIFY_TOKEN,
//          META_WA_BUSINESS_NUMBER (shown to merchants), META_GRAPH_VERSION (default v25.0)
//   twilio Twilio WhatsApp (the same sender as WhatsApp alerts). Buttons and lists are
//          shown as numbered options; the merchant replies with the number.
// WHATSAPP_PROVIDER forces one; otherwise Meta is used when it is configured.

import crypto from "node:crypto";
import db from "../../db.server";
import { sendWhatsapp, twilio, type SendResult } from "../notify.server";

export type Provider = "meta" | "twilio";

export interface WaButton {
  id: string;
  title: string;
}
export interface WaRow {
  id: string;
  title: string;
  description?: string;
}
export interface WaReply {
  text: string;
  header?: string;
  footer?: string;
  /** Up to 3 buttons. */
  buttons?: WaButton[];
  /** A list behind one button: up to 10 rows in total. */
  list?: { button: string; sections: { title: string; rows: WaRow[] }[] };
  /** A chart or other image, sent before the text. */
  imageUrl?: string;
}

/** What the merchant sent: typed text, or the id of a button or list row they tapped. */
export interface Inbound {
  messageId: string;
  phone: string;
  text: string;
  replyId?: string;
}

export function whatsappProvider(): Provider | null {
  const forced = process.env.WHATSAPP_PROVIDER;
  const meta = !!process.env.META_WA_TOKEN && !!process.env.META_WA_PHONE_NUMBER_ID;
  const tw = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_WHATSAPP_FROM;
  if (forced === "meta") return meta ? "meta" : null;
  if (forced === "twilio") return tw ? "twilio" : null;
  return meta ? "meta" : tw ? "twilio" : null;
}

/** The store's WhatsApp number, in digits, for wa.me links. */
export function businessNumber(): string | null {
  const p = whatsappProvider();
  const raw = p === "meta" ? process.env.META_WA_BUSINESS_NUMBER : p === "twilio" ? process.env.TWILIO_WHATSAPP_FROM : undefined;
  const digits = (raw ?? "").replace(/^whatsapp:/, "").replace(/\D/g, "");
  return digits || null;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every option in a reply, in the order the numbered (Twilio) version shows them. */
export function optionsOf(reply: WaReply): WaRow[] {
  return [...(reply.buttons ?? []).map((b) => ({ id: b.id, title: b.title })), ...(reply.list?.sections.flatMap((s) => s.rows) ?? [])];
}

/** The numbered-text version of a reply, used when real buttons are not available. */
export function numberedText(reply: WaReply, start = 1): string {
  const parts = [reply.header ? `*${reply.header}*` : null, reply.text].filter(Boolean) as string[];
  const options = optionsOf(reply);
  if (options.length) {
    parts.push(options.map((o, i) => `*${start + i}.* ${o.title}${o.description ? ` (${o.description})` : ""}`).join("\n"));
    parts.push("_Reply with a number._");
  }
  if (reply.footer) parts.push(`_${reply.footer}_`);
  return parts.join("\n\n");
}

/** The Cloud API message body for a reply (without the image, which is sent separately). */
export function metaMessage(to: string, reply: WaReply): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/^\+/, "") };
  const header = reply.header ? { header: { type: "text", text: cut(reply.header, 60) } } : {};
  const footer = reply.footer ? { footer: { text: cut(reply.footer, 60) } } : {};
  if (reply.buttons?.length) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        ...header,
        body: { text: cut(reply.text, 1024) },
        ...footer,
        action: { buttons: reply.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: cut(b.title, 20) } })) },
      },
    };
  }
  if (reply.list?.sections.some((s) => s.rows.length)) {
    let left = 10;
    const sections = reply.list.sections
      .map((s) => {
        const rows = s.rows.slice(0, Math.max(0, left));
        left -= rows.length;
        return {
          title: cut(s.title, 24),
          rows: rows.map((r) => ({ id: r.id.slice(0, 200), title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })),
        };
      })
      .filter((s) => s.rows.length);
    return {
      ...base,
      type: "interactive",
      interactive: { type: "list", ...header, body: { text: cut(reply.text, 1024) }, ...footer, action: { button: cut(reply.list.button, 20), sections } },
    };
  }
  return { ...base, type: "text", text: { body: cut(reply.text, 4096), preview_url: false } };
}

async function metaSend(body: Record<string, unknown>) {
  const version = process.env.META_GRAPH_VERSION ?? "v25.0";
  const res = await fetch(`https://graph.facebook.com/${version}/${process.env.META_WA_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.META_WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    throw new Error(`WhatsApp: ${err.error?.message ?? res.status}${err.error?.code ? ` (${err.error.code})` : ""}`);
  }
}

/**
 * Sends replies in order. Returns the option ids in the order they were numbered,
 * so a typed "2" can be matched to an option (always for Twilio, harmless for Meta).
 */
export async function sendReplies(phone: string, replies: WaReply[]): Promise<string[]> {
  const provider = whatsappProvider();
  if (!provider) throw new Error("WhatsApp is not set up on the server");
  const numbered: string[] = [];
  for (const reply of replies) {
    if (provider === "meta") {
      if (reply.imageUrl) await metaSend({ messaging_product: "whatsapp", to: phone.replace(/^\+/, ""), type: "image", image: { link: reply.imageUrl } });
      await metaSend(metaMessage(phone, reply));
      numbered.push(...optionsOf(reply).map((o) => o.id));
    } else {
      const text = numberedText(reply, numbered.length + 1);
      numbered.push(...optionsOf(reply).map((o) => o.id));
      const from = process.env.TWILIO_WHATSAPP_FROM!;
      const r = await twilio({
        To: `whatsapp:${phone}`,
        From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
        Body: cut(text, 1500),
        ...(reply.imageUrl ? { MediaUrl: reply.imageUrl } : {}),
      });
      if (!r.ok) throw new Error(`WhatsApp: ${r.error}`);
    }
  }
  return numbered;
}

// ---------- Inbound ----------

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Meta signs the raw body with the app secret. */
export function verifyMeta(rawBody: string, signature: string | null) {
  const secret = process.env.META_WA_APP_SECRET;
  if (!secret || !signature) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signature);
}

/** Twilio signs the public URL followed by every form field, sorted by name. */
export function verifyTwilio(url: string, params: Record<string, string>, signature: string | null) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  return safeEqual(expected, signature);
}

export function parseMeta(body: any): Inbound[] {
  const out: Inbound[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        const phone = `+${String(m.from ?? "").replace(/\D/g, "")}`;
        if (m.type === "text") out.push({ messageId: m.id, phone, text: String(m.text?.body ?? "") });
        else if (m.type === "interactive") {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (r) out.push({ messageId: m.id, phone, text: String(r.title ?? ""), replyId: String(r.id) });
        } else if (m.type === "button") {
          out.push({ messageId: m.id, phone, text: String(m.button?.text ?? ""), replyId: m.button?.payload ? String(m.button.payload) : undefined });
        } else {
          out.push({ messageId: m.id, phone, text: "" });
        }
      }
    }
  }
  return out;
}

export function parseTwilio(params: Record<string, string>): Inbound | null {
  if (!params.MessageSid || !params.From) return null;
  const phone = params.From.replace(/^whatsapp:/, "");
  return { messageId: params.MessageSid, phone, text: params.Body ?? "", replyId: params.ButtonPayload || undefined };
}

// ---------- Alerts ----------

const DAY_MS = 24 * 3_600_000;

/**
 * An alert on WhatsApp. With Twilio it is a plain message. With Meta, a business can
 * only start a conversation with an approved template (META_WA_ALERT_TEMPLATE, one
 * body variable); within 24 hours of the merchant's last message it can send buttons.
 */
export async function sendWhatsappAlert(phone: string, text: string, shop?: string): Promise<SendResult> {
  if (whatsappProvider() !== "meta") return sendWhatsapp(phone, text);
  // The 24-hour window belongs to the phone, whichever store it last talked to.
  const last = await db.whatsappLink.findFirst({ where: { phone }, orderBy: { lastInboundAt: "desc" } });
  const inWindow = !!last?.lastInboundAt && Date.now() - last.lastInboundAt.getTime() < DAY_MS - 5 * 60_000;
  // Buttons open this store's menus, switching to it first if the phone serves several stores.
  const link = shop ? await db.whatsappLink.findUnique({ where: { shop_phone: { shop, phone } } }) : null;
  const go = (route: string) => (link ? `sw:${link.id}:${route}` : route);
  try {
    if (inWindow) {
      await metaSend(
        metaMessage(phone, {
          text,
          buttons: [
            { id: go("al"), title: "Show alerts" },
            { id: go("ro"), title: "Reorder now" },
            { id: go("menu"), title: "Main menu" },
          ],
        }),
      );
      return { ok: true };
    }
    const template = process.env.META_WA_ALERT_TEMPLATE;
    if (!template) return { ok: false, error: "WhatsApp needs an approved alert template to message you first; send any message to the assistant to get alerts for the next 24 hours" };
    await metaSend({
      messaging_product: "whatsapp",
      to: phone.replace(/^\+/, ""),
      type: "template",
      template: {
        name: template,
        language: { code: process.env.META_WA_ALERT_TEMPLATE_LANG ?? "en" },
        // Template variables cannot contain line breaks.
        components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\s*\n+\s*/g, " · ").slice(0, 1000) }] }],
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "WhatsApp send failed" };
  }
}
