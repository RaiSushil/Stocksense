// Handles each incoming WhatsApp message: ignores repeats, links phones with a code,
// keeps one phone's messages in order, rate limits, and sends the replies.

import crypto from "node:crypto";
import db from "../../db.server";
import { inBackground } from "../jobs.server";
import { expireOld } from "./actions.server";
import { handle, readState } from "./menus.server";
import { sendReplies, type Inbound, type WaReply } from "./provider.server";

const CODE_TTL_MS = 10 * 60_000;
const PER_MINUTE = 20;

/** A new one-time code that links the phone that sends it to this store. */
export async function createLinkCode(shop: string) {
  await db.whatsappCode.deleteMany({ where: { OR: [{ shop }, { expiresAt: { lt: new Date() } }] } });
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      return await db.whatsappCode.create({ data: { code, shop, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
    } catch {
      // Taken by another store this minute: try another.
    }
  }
  throw new Error("Could not create a code. Try again.");
}

const queues = new Map<string, Promise<void>>();
const recent = new Map<string, number[]>();

function rateLimited(phone: string) {
  const now = Date.now();
  const list = (recent.get(phone) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  recent.set(phone, list);
  return list.length > PER_MINUTE;
}

/** Called by the webhook. Returns at once; the work happens in order per phone. */
export function enqueue(messages: Inbound[]) {
  for (const m of messages) {
    const prev = queues.get(m.phone) ?? Promise.resolve();
    const next = prev.then(async () => void (await processOne(m))).catch((err) => console.error("[stocksense] whatsapp message failed", err));
    queues.set(m.phone, next);
    inBackground("whatsapp", next.finally(() => queues.get(m.phone) === next && queues.delete(m.phone)));
  }
}

export async function processOne(m: Inbound): Promise<WaReply[]> {
  // Providers deliver again when they don't hear back quickly; handle each message once.
  try {
    await db.whatsappInbound.create({ data: { id: m.messageId } });
  } catch {
    return [];
  }
  if (rateLimited(m.phone)) return [];
  const replies = await repliesFor(m);
  if (replies.length) {
    try {
      const options = await sendReplies(m.phone, replies);
      const link = await activeLink(m.phone);
      if (link) await db.whatsappLink.update({ where: { id: link.id }, data: { state: mergeState(link, { options }) } });
    } catch (err) {
      console.error("[stocksense] whatsapp send failed", err);
    }
  }
  return replies;
}

function mergeState(link: { state: string | null } | null, patch: Record<string, unknown>) {
  const current = link ? readState(link as never) : {};
  return JSON.stringify({ ...current, ...patch });
}

/**
 * The store a phone is talking to. A phone linked to several stores has one active
 * link; if none is marked (for example after one was removed), the most recently used wins.
 */
export async function activeLink(phone: string) {
  const links = await db.whatsappLink.findMany({ where: { phone }, orderBy: [{ active: "desc" }, { lastInboundAt: "desc" }, { createdAt: "desc" }] });
  const link = links[0];
  if (link && !link.active) await db.whatsappLink.update({ where: { id: link.id }, data: { active: true } });
  return link ? { ...link, active: true } : null;
}

export async function repliesFor(m: Inbound): Promise<WaReply[]> {
  const text = m.text.trim();
  const linkCmd = /^link\s+(\d{6})$/i.exec(text);
  if (linkCmd) return linkPhone(m.phone, linkCmd[1]);

  const link = await activeLink(m.phone);
  if (!link) {
    return [{ text: "This number is not connected to a store yet.\n\nIn Shopify, open StockSense, then Settings, WhatsApp, and tap *Connect a phone*. Then send the code shown there." }];
  }
  await db.whatsappLink.update({ where: { id: link.id }, data: { lastInboundAt: new Date() } });
  await expireOld();
  const out = await handle(link, m);
  if (out.form !== undefined) {
    const fresh = await db.whatsappLink.findUnique({ where: { id: link.id } });
    if (fresh) await db.whatsappLink.update({ where: { id: link.id }, data: { state: mergeState(fresh, { form: out.form }) } });
  }
  return out.replies;
}

async function linkPhone(phone: string, code: string): Promise<WaReply[]> {
  const row = await db.whatsappCode.findUnique({ where: { code } });
  if (!row || row.expiresAt < new Date()) return [{ text: "That code is not valid or has expired. Create a new one in StockSense: Settings, WhatsApp." }];
  await db.whatsappCode.delete({ where: { code } });
  // One phone can serve several stores; the store just linked becomes the active one.
  const link = await db.whatsappLink.upsert({
    where: { shop_phone: { shop: row.shop, phone } },
    create: { shop: row.shop, phone, active: true },
    update: { active: true },
  });
  await db.whatsappLink.updateMany({ where: { phone, NOT: { id: link.id } }, data: { active: false } });
  const others = await db.whatsappLink.count({ where: { phone, NOT: { id: link.id } } });
  const shop = await db.shop.findUnique({ where: { id: row.shop } });
  return [
    {
      header: "Connected",
      text: `This number is now connected to *${shop?.name ?? row.shop}*.${
        others ? `\nIt is also connected to ${others} other store${others === 1 ? "" : "s"}; use *Switch store* in Settings and help to change.` : ""
      }\n\nUse the menu, or just type a question. Every change asks for your approval first, and nothing can be deleted from WhatsApp.`,
      buttons: [{ id: "menu", title: "Main menu" }],
    },
  ];
}
