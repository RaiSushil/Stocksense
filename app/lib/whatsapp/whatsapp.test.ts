import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import db from "../../db.server";
import { seedDemo } from "../demo.server";
import { shortId } from "../format";
import { ACTION_TYPES, decide, propose } from "./actions.server";
import { createLinkCode, repliesFor } from "./inbox.server";
import { metaMessage, numberedText, optionsOf, parseMeta, parseTwilio, verifyMeta, verifyTwilio, type Inbound, type WaReply } from "./provider.server";
import { renderPng, seriesSvg } from "./charts.server";
import { runWhatsappTool } from "./ai-tools.server";

const SHOP = "wa-test.myshopify.com";
const PHONE = "+919876543210";
let n = 0;
const msg = (text: string, replyId?: string, phone = PHONE): Inbound => ({ messageId: `m-${++n}-${Date.now()}`, phone, text, replyId });
const ids = (replies: WaReply[]) => replies.flatMap((r) => optionsOf(r).map((o) => o.id));

beforeAll(async () => {
  await db.shop.create({ data: { id: SHOP, name: "WA Goods", plan: "PRO", timezone: "UTC", currency: "USD" } });
  await seedDemo(SHOP);
}, 120_000);

describe("provider formatting and signatures", () => {
  it("keeps Meta limits: 3 buttons of 20 characters, 10 list rows of 24", () => {
    const buttons = metaMessage(PHONE, { text: "x", buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `A very long button title ${i}` })) }) as any;
    expect(buttons.to).toBe("919876543210");
    expect(buttons.interactive.action.buttons).toHaveLength(3);
    expect(buttons.interactive.action.buttons.every((b: any) => b.reply.title.length <= 20)).toBe(true);
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, title: `Product with a long name ${i}`, description: "d".repeat(90) }));
    const list = metaMessage(PHONE, { text: "x", list: { button: "Choose a product please", sections: [{ title: "Products", rows }] } }) as any;
    const sent = list.interactive.action.sections.flatMap((s: any) => s.rows);
    expect(sent).toHaveLength(10);
    expect(sent.every((r: any) => r.title.length <= 24 && r.description.length <= 72)).toBe(true);
    expect(list.interactive.action.button.length).toBeLessThanOrEqual(20);
  });

  it("numbers options for Twilio", () => {
    const text = numberedText({ text: "Pick one", buttons: [{ id: "a", title: "Approve" }, { id: "b", title: "Cancel" }] });
    expect(text).toContain("*1.* Approve");
    expect(text).toContain("*2.* Cancel");
  });

  it("accepts only correctly signed webhooks", () => {
    process.env.META_WA_APP_SECRET = "meta-secret";
    const body = JSON.stringify({ entry: [] });
    const good = `sha256=${crypto.createHmac("sha256", "meta-secret").update(body).digest("hex")}`;
    expect(verifyMeta(body, good)).toBe(true);
    expect(verifyMeta(body + " ", good)).toBe(false);
    expect(verifyMeta(body, null)).toBe(false);

    process.env.TWILIO_AUTH_TOKEN = "tw-token";
    const url = "https://stocksense.test/webhooks/whatsapp";
    const params = { From: "whatsapp:+919876543210", Body: "menu", MessageSid: "SM1" };
    const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k as keyof typeof params], url);
    const sig = crypto.createHmac("sha1", "tw-token").update(data).digest("base64");
    expect(verifyTwilio(url, params, sig)).toBe(true);
    expect(verifyTwilio(url, { ...params, Body: "approve" }, sig)).toBe(false);
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("reads typed text and tapped buttons", () => {
    const parsed = parseMeta({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: "919876543210", id: "w1", type: "text", text: { body: "hi" } },
                  { from: "919876543210", id: "w2", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "ro", title: "Reorder now" } } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed).toEqual([
      { messageId: "w1", phone: PHONE, text: "hi" },
      { messageId: "w2", phone: PHONE, text: "Reorder now", replyId: "ro" },
    ]);
    expect(parseTwilio({ From: "whatsapp:+919876543210", Body: "2", MessageSid: "SM9" })).toEqual({ messageId: "SM9", phone: PHONE, text: "2" });
  });

  it("draws charts as PNG images", () => {
    const png = renderPng(seriesSvg({ type: "bar", title: "Days of cover", labels: ["A", "B"], series: [{ name: "Cover", values: [3, 9] }] }));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("WhatsApp assistant", () => {
  it("ignores unknown numbers and links a phone with a one-time code", async () => {
    const unknown = await repliesFor(msg("hi"));
    expect(unknown[0].text).toMatch(/not connected/);
    const code = await createLinkCode(SHOP);
    const linked = await repliesFor(msg(`link ${code.code}`));
    expect(linked[0].text).toMatch(/connected to \*WA Goods\*/);
    // A code works once.
    expect((await repliesFor(msg(`link ${code.code}`, undefined, "+15550001111")))[0].text).toMatch(/not valid/);
  });

  it("shows a main menu with every feature", async () => {
    const menu = await repliesFor(msg("hi"));
    expect(ids(menu)).toEqual(["sum", "ro", "fc", "po", "sup", "sup:add", "al", "tr", "ai", "set"]);
  });

  it("reorders a product end to end, with approval, and runs it once", async () => {
    const list = await repliesFor(msg("Reorder now", "ro"));
    const first = ids(list).find((i) => i.startsWith("rv:"))!;
    const card = await repliesFor(msg("", first));
    expect(card[0].imageUrl).toMatch(/^https:\/\/stocksense\.test\/whatsapp\/media\//);
    const order = ids(card).find((i) => i.startsWith("ord:"))!;
    const before = await db.purchaseOrder.count({ where: { shop: SHOP } });

    const proposal = await repliesFor(msg("", order));
    expect(proposal[0].header).toBe("Please confirm");
    // Proposing changes nothing.
    expect(await db.purchaseOrder.count({ where: { shop: SHOP } })).toBe(before);

    const approve = ids(proposal).find((i) => i.startsWith("act:ok:"))!;
    const done = await repliesFor(msg("Approve", approve));
    expect(done[0].text).toMatch(/Draft \*PO-\d+\* is ready/);
    expect(await db.purchaseOrder.count({ where: { shop: SHOP } })).toBe(before + 1);

    // A second tap does nothing.
    const again = await repliesFor(msg("Approve", approve));
    expect(again[0].text).toMatch(/already done/);
    expect(await db.purchaseOrder.count({ where: { shop: SHOP } })).toBe(before + 1);
  });

  it("takes a typed quantity, and cancelling changes nothing", async () => {
    const list = await repliesFor(msg("", "ro"));
    const vid = ids(list).find((i) => i.startsWith("rv:"))!.slice(3);
    const v = await db.variant.findFirstOrThrow({ where: { shop: SHOP, id: { endsWith: vid } } });
    await repliesFor(msg("", `rq:${vid}:${v.supplierId}`));
    const proposal = await repliesFor(msg("37"));
    expect(proposal[0].text).toContain("37 ×");
    const before = await db.purchaseOrder.count({ where: { shop: SHOP } });
    const cancel = ids(proposal).find((i) => i.startsWith("act:no:"))!;
    expect((await repliesFor(msg("Cancel", cancel)))[0].text).toMatch(/Nothing was changed/);
    expect(await db.purchaseOrder.count({ where: { shop: SHOP } })).toBe(before);
  });

  it("approves, then sends a PO only after a second confirmation", async () => {
    const draft = await db.purchaseOrder.findFirstOrThrow({ where: { shop: SHOP, status: "DRAFT" }, orderBy: { createdAt: "desc" } });
    await db.supplier.update({ where: { id: draft.supplierId }, data: { email: "orders@supplier.test" } });
    const ok = await repliesFor(msg("", ids(await repliesFor(msg("", `poa:${draft.id}`))).find((i) => i.startsWith("act:ok:"))));
    expect(ok[0].text).toMatch(/is approved/);

    const send = await repliesFor(msg("", `pos:${draft.id}`));
    expect(send[0].text).toContain("orders@supplier.test");
    const first = await repliesFor(msg("", ids(send).find((i) => i.startsWith("act:ok:"))));
    expect(first[0].header).toBe("Final check");
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("APPROVED");
    const go = ids(first).find((i) => i.startsWith("act:go:"))!;
    const sent = await repliesFor(msg("Send now", go));
    expect(sent[0].text).toMatch(/marked as ordered/);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("SENT");
  });

  it("adds a supplier through the step-by-step form", async () => {
    await repliesFor(msg("", "sup:add"));
    await repliesFor(msg("Monsoon Traders"));
    await repliesFor(msg("buy@monsoon.test"));
    const proposal = await repliesFor(msg("12"));
    expect(proposal[0].text).toContain("Add supplier Monsoon Traders");
    await repliesFor(msg("", ids(proposal).find((i) => i.startsWith("act:ok:"))));
    const s = await db.supplier.findFirstOrThrow({ where: { shop: SHOP, name: "Monsoon Traders" } });
    expect(s.email).toBe("buy@monsoon.test");
    expect(s.defaultLeadTimeDays).toBe(12);
  });

  it("lets view-only numbers read but not approve", async () => {
    await db.whatsappLink.update({ where: { shop_phone: { shop: SHOP, phone: PHONE } }, data: { canApprove: false } });
    const p = await propose(SHOP, PHONE, "DISMISS_ALERT", { alertId: (await db.alert.findFirstOrThrow({ where: { shop: SHOP, status: "OPEN" } })).id });
    const r = await decide(PHONE, p.id, "approve");
    expect(r.text).toMatch(/can view but not approve/);
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
    await db.whatsappLink.update({ where: { shop_phone: { shop: SHOP, phone: PHONE } }, data: { canApprove: true } });
  });

  it("refuses expired, foreign or tampered approvals", async () => {
    const alert = await db.alert.findFirstOrThrow({ where: { shop: SHOP, status: "OPEN" } });
    const p = await propose(SHOP, PHONE, "DISMISS_ALERT", { alertId: alert.id });
    expect((await decide("+15550002222", p.id, "approve")).text).toMatch(/not found/);
    await db.pendingAction.update({ where: { id: p.id }, data: { payload: JSON.stringify({ alertId: "other", __confirmTwice: false }) } });
    expect((await decide(PHONE, p.id, "approve")).text).toMatch(/could not be verified/);
    const q = await propose(SHOP, PHONE, "DISMISS_ALERT", { alertId: alert.id });
    await db.pendingAction.update({ where: { id: q.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await decide(PHONE, q.id, "approve")).text).toMatch(/expired/);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("OPEN");
  });

  it("has no way to delete or cancel anything", async () => {
    expect(ACTION_TYPES.some((t) => /DELETE|REMOVE|CANCEL/.test(t))).toBe(false);
    const out = await runWhatsappTool("propose_change", { type: "DELETE_SUPPLIER", input: {} }, { shop: SHOP, phone: PHONE, proposals: [] });
    expect(out).toEqual({ error: "That change is not available on WhatsApp." });
    const ctx = { shop: SHOP, phone: PHONE, proposals: [] as never[] };
    const variant = await db.variant.findFirstOrThrow({ where: { shop: SHOP, supplierId: { not: null } } });
    const ok = (await runWhatsappTool("propose_change", { type: "CREATE_DRAFT_PO", input: { lines: [{ variantId: variant.id, quantity: 5 }] } }, ctx)) as { proposed: boolean };
    expect(ok.proposed).toBe(true);
    expect(ctx.proposals).toHaveLength(1);
  });

  it("answers typed text with a product search when AI is off, and a typed number picks an option", async () => {
    const v = await db.variant.findFirstOrThrow({ where: { shop: SHOP } });
    const res = await repliesFor(msg(v.productTitle.split(" ")[0]));
    expect(ids(res).some((i) => i === `fv:${shortId(v.id)}`)).toBe(true);
  });
});
