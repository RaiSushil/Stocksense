// The WhatsApp assistant: menus for every StockSense feature, like a bank's WhatsApp
// menu, plus free-text questions answered by Ask StockSense. Reading is instant;
// every change goes through actions.server.ts and needs the merchant's approval.

import db from "../../db.server";
import { addDays, shortDate, todayIn } from "../dates";
import { money, num, shortId, STATUS_LABEL, variantLabel } from "../format";
import { hasFeature } from "../plans";
import { dashboardData } from "../dashboard.server";
import { stockCurve } from "../curve.server";
import { leadTimeStats } from "../suppliers.server";
import { orderBreakdown } from "../forecast/inventory";
import { OPEN_STATUSES, poTotal } from "../po.server";
import { transferSuggestions } from "../transfers.server";
import { ask, AskQuotaError } from "../ask/agent.server";
import { ActionError, decide, propose, type ActionType } from "./actions.server";
import { publishImage, renderPng, seriesSvg, stockSvg } from "./charts.server";
import type { Inbound, WaReply, WaRow } from "./provider.server";

type Link = { id: string; shop: string; phone: string; canApprove: boolean; state: string | null; threadId: string | null; active: boolean };
type Shop = Awaited<ReturnType<typeof db.shop.findUniqueOrThrow>>;

type Form =
  | { kind: "search" }
  | { kind: "ai" }
  | { kind: "qty"; variantId: string; supplierId?: string }
  | { kind: "rules"; variantId: string; field: "casePack" | "minOrderQty" | "leadTimeDays" }
  | { kind: "supplierEdit"; supplierId: string; field: "email" | "leadTimeDays" | "phone" }
  | { kind: "newSupplier"; step: "name" | "email" | "lead"; data: { name?: string; email?: string } };

interface State {
  options?: string[];
  form?: Form | null;
}

const PAGE = 9;
const MENU_BTN = { id: "menu", title: "Main menu" };
const gid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function readState(link: Link): State {
  try {
    return link.state ? (JSON.parse(link.state) as State) : {};
  } catch {
    return {};
  }
}

// ---------- Entry point ----------

export interface Handled {
  replies: WaReply[];
  /** The new form in progress, or null to clear it, or undefined to keep it. */
  form?: Form | null;
}

export async function handle(link: Link, msg: Inbound): Promise<Handled> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: link.shop } });
  if (shop.uninstalledAt && !(msg.replyId ?? "").startsWith("sw")) {
    const others = await db.whatsappLink.count({ where: { phone: link.phone, NOT: { id: link.id } } });
    return { replies: [{ text: "StockSense is no longer installed on this store.", ...(others ? { buttons: [{ id: "sw", title: "Switch store" }] } : {}) }], form: null };
  }
  if (!hasFeature(shop.plan, "phoneAlerts") && !(msg.replyId ?? "").startsWith("sw")) {
    return { replies: [{ text: "The WhatsApp assistant is included in the Scale and Pro plans. Open StockSense in Shopify to change plan." }], form: null };
  }
  const state = readState(link);
  const text = msg.text.trim();
  let id = msg.replyId;
  // A typed number picks from the last numbered options.
  if (!id && /^\d{1,2}$/.test(text) && state.options?.length && !state.form) {
    id = state.options[Number(text) - 1];
  }
  try {
    if (id) return await route(shop, link, id);
    if (/^(hi|hii|hello|hey|menu|main menu|start|home|0)$/i.test(text)) return { replies: [mainMenu(shop)], form: null };
    if (/^(stop|unlink|disconnect)$/i.test(text)) return route(shop, link, "unlink");
    if (/^help$/i.test(text)) return route(shop, link, "set");
    if (state.form && state.form.kind !== "ai") return await formInput(shop, link, state.form, text);
    return await freeText(shop, link, text);
  } catch (err) {
    if (err instanceof ActionError) return { replies: [{ text: err.message, buttons: [MENU_BTN] }] };
    console.error("[stocksense] whatsapp", err);
    return { replies: [{ text: "Something went wrong. Please try again.", buttons: [MENU_BTN] }], form: null };
  }
}

// ---------- Menus ----------

export function mainMenu(shop: Shop): WaReply {
  const rows: WaRow[] = [
    { id: "sum", title: "Today's summary", description: "Stock at risk, drafts, cash in overstock" },
    { id: "ro", title: "Reorder now", description: "What to order, how much and from whom" },
    { id: "fc", title: "Product forecast", description: "Search by product name or SKU" },
    { id: "po", title: "Purchase orders", description: "Approve, send and receive" },
    { id: "sup", title: "Suppliers", description: "Lead times, contacts, preferred supplier" },
    { id: "sup:add", title: "Add a supplier" },
    { id: "al", title: "Alerts", description: "Stockout risks and other alerts" },
    { id: "tr", title: "Transfers", description: hasFeature(shop.plan, "transfers") ? "Move stock between locations" : "Pro plan" },
    { id: "ai", title: "Ask StockSense AI", description: "Ask anything in your own words" },
    { id: "set", title: "Settings and help" },
  ];
  return {
    header: "StockSense",
    text: `What would you like to do for *${shop.name ?? shop.id}*?\n\nYou can also just type a question, like "what runs out this week?"`,
    footer: "Changes always need your approval",
    list: { button: "Main menu", sections: [{ title: "StockSense", rows }] },
  };
}

async function route(shop: Shop, link: Link, id: string): Promise<Handled> {
  const [head, a, b, c, d] = id.split(":");
  const fmt = (n: number) => money(n, shop.currency);
  const today = todayIn(shop.timezone);

  switch (head) {
    case "menu":
      return { replies: [mainMenu(shop)], form: null };

    case "act": {
      const decision = a === "ok" ? "approve" : a === "go" ? "confirm" : "cancel";
      return { replies: [await decide(link.phone, b, decision)], form: null };
    }

    case "sw": {
      // sw            list the stores this phone is linked to
      // sw:<link>     make that store active
      // sw:<link>:<route>  switch, then open a menu there (used by alert buttons)
      const links = await db.whatsappLink.findMany({ where: { phone: link.phone }, orderBy: { createdAt: "asc" } });
      if (!a) {
        if (links.length < 2) return { replies: [{ text: `This number is only connected to *${shop.name ?? shop.id}*.`, buttons: [MENU_BTN] }], form: null };
        const names = new Map((await db.shop.findMany({ where: { id: { in: links.map((l) => l.shop) } } })).map((x) => [x.id, x.name ?? x.id]));
        return {
          replies: [
            {
              header: "Switch store",
              text: `You are using *${shop.name ?? shop.id}*. Which store do you want?`,
              list: { button: "Stores", sections: [{ title: "Stores", rows: links.slice(0, 10).map((l) => ({ id: `sw:${l.id}`, title: cut(names.get(l.shop) ?? l.shop, 24), description: l.shop === shop.id ? "current" : l.shop })) }] },
            },
          ],
          form: null,
        };
      }
      const target = links.find((l) => l.id === a);
      if (!target) return { replies: [{ text: "That store is not connected to this number.", buttons: [MENU_BTN] }], form: null };
      await db.$transaction([
        db.whatsappLink.updateMany({ where: { phone: link.phone }, data: { active: false } }),
        db.whatsappLink.update({ where: { id: target.id }, data: { active: true } }),
      ]);
      const next = await db.shop.findUniqueOrThrow({ where: { id: target.shop } });
      if (b) return route(next, { ...target, active: true }, [b, c, d].filter(Boolean).join(":"));
      return { replies: [{ text: `Switched to *${next.name ?? next.id}*.` }, mainMenu(next)], form: null };
    }

    case "sum": {
      const data = await dashboardData(shop.id, "");
      const k = data.kpis;
      const top = (data.attention as { label: string; cover: number; revenueAtRisk: number }[]).slice(0, 3);
      return {
        replies: [
          {
            header: "Today's summary",
            text: [
              `*${k.needReorder}* product${k.needReorder === 1 ? "" : "s"} to reorder (${k.critical} critical)`,
              `*${k.draftsReady}* draft purchase order${k.draftsReady === 1 ? "" : "s"} ready`,
              `*${fmt(k.cashInOverstock)}* tied up in overstock`,
              k.accuracy !== null ? `Forecast accuracy *${Math.round(k.accuracy * 1000) / 10}%*` : null,
              top.length ? `\n*Most at risk*\n${top.map((t) => `- ${t.label}: ${num(t.cover)} days left, ${fmt(t.revenueAtRisk)} at risk`).join("\n")}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            buttons: [{ id: "ro", title: "Reorder now" }, { id: "al", title: "Alerts" }, MENU_BTN],
          },
        ],
        form: null,
      };
    }

    case "ro": {
      const page = Number(a ?? 0) || 0;
      const rows = await db.forecast.findMany({
        where: { shop: shop.id, locationId: "", status: { in: ["REORDER_NOW", "WATCH"] } },
        orderBy: [{ status: "asc" }, { daysOfCover: "asc" }],
        skip: page * PAGE,
        take: PAGE + 1,
      });
      if (!rows.length) return { replies: [{ text: "Nothing needs reordering right now.", buttons: [MENU_BTN] }], form: null };
      const variants = await variantMap(rows.map((r) => r.variantId));
      const list = rows.slice(0, PAGE).map((r) => ({
        id: `rv:${shortId(r.variantId)}`,
        title: cut(variants.get(r.variantId) ? variantLabel(variants.get(r.variantId)!) : r.variantId, 24),
        description: `${STATUS_LABEL[r.status] ?? r.status} · ${num(r.daysOfCover)} days left · order ${num(r.suggestedQty)}`,
      }));
      if (rows.length > PAGE) list.push({ id: `ro:${page + 1}`, title: "More…", description: "Show the next products" });
      return { replies: [{ header: "Reorder now", text: "Products that need stock, most urgent first. Pick one to order.", list: { button: "Choose product", sections: [{ title: "Products", rows: list }] } }], form: null };
    }

    case "rv":
    case "fv": {
      const variantId = gid(a);
      return { replies: await productCard(shop, variantId, head === "rv"), form: null };
    }

    case "rs": {
      // Supplier comparison for one product.
      const variantId = gid(a);
      const options = await supplierOptions(shop, variantId);
      if (!options.length) return { replies: [{ text: "No suppliers yet. Add one first.", buttons: [{ id: "sup:add", title: "Add a supplier" }, MENU_BTN] }], form: null };
      return {
        replies: [
          {
            header: "Choose a supplier",
            text: "Lead time, arrival date and how many to order from each supplier.",
            list: {
              button: "Suppliers",
              sections: [
                {
                  title: "Suppliers",
                  rows: options.slice(0, 10).map((o) => ({
                    id: `rp:${a}:${o.id}`,
                    title: cut(o.name, 24),
                    description: `${num(o.lead, o.lead % 1 ? 1 : 0)} days, arrives ${shortDate(addDays(today, Math.ceil(o.lead)))}, order ${num(o.qty)}`,
                  })),
                },
              ],
            },
          },
        ],
        form: null,
      };
    }

    case "rp": {
      // One supplier chosen for one product: order from it, or make it the preferred one.
      const variantId = gid(a);
      const o = (await supplierOptions(shop, variantId)).find((x) => x.id === b);
      const v = await db.variant.findFirst({ where: { id: variantId, shop: shop.id } });
      if (!o || !v) return { replies: [{ text: "That supplier or product was not found.", buttons: [MENU_BTN] }] };
      return {
        replies: [
          {
            header: o.name,
            text: `${variantLabel(v)}\nLead time *${num(o.lead, o.lead % 1 ? 1 : 0)} days*, arrives *${shortDate(addDays(today, Math.ceil(o.lead)))}*.\nSuggested order *${num(o.qty)}* units (${fmt(o.qty * (v.unitCost ?? 0))}).`,
            buttons: [
              ...(o.qty > 0 ? [{ id: `ord:${a}:${o.id}:${o.qty}`, title: cut(`Order ${o.qty}`, 20) }] : []),
              { id: `rq:${a}:${o.id}`, title: "Other quantity" },
              { id: `pref:${a}:${o.id}`, title: "Make preferred" },
            ],
          },
        ],
        form: null,
      };
    }

    case "ord": {
      // ord:<variant>:<supplier>:<qty>
      const p = await propose(shop.id, link.phone, "CREATE_DRAFT_PO", { supplierId: b || undefined, lines: [{ variantId: gid(a), quantity: Number(c) }] });
      return { replies: [p.reply], form: null };
    }

    case "rq":
      return { replies: [{ text: "How many units do you want to order? Type a number.", buttons: [MENU_BTN] }], form: { kind: "qty", variantId: gid(a), supplierId: b || undefined } };

    case "pref": {
      const v = await db.variant.findFirst({ where: { id: gid(a), shop: shop.id } });
      if (!v) return { replies: [{ text: "Product not found.", buttons: [MENU_BTN] }] };
      const replies: WaReply[] = [];
      if (v.productType) {
        replies.push({
          text: `Use this supplier only for ${variantLabel(v)}, or for every *${v.productType}* product?`,
          buttons: [
            { id: `prefx:${a}:${b}:0`, title: "This product" },
            { id: `prefx:${a}:${b}:1`, title: cut(`All ${v.productType}`, 20) },
            MENU_BTN,
          ],
        });
        return { replies, form: null };
      }
      return { replies: [(await propose(shop.id, link.phone, "SET_PREFERRED_SUPPLIER", { variantId: v.id, supplierId: b })).reply], form: null };
    }

    case "prefx":
      return { replies: [(await propose(shop.id, link.phone, "SET_PREFERRED_SUPPLIER", { variantId: gid(a), supplierId: b, forCategory: c === "1" })).reply], form: null };

    case "rr": {
      const v = await db.variant.findFirst({ where: { id: gid(a), shop: shop.id } });
      if (!v) return { replies: [{ text: "Product not found.", buttons: [MENU_BTN] }] };
      return {
        replies: [
          {
            header: "Reorder rules",
            text: `${variantLabel(v)}\nCase pack *${v.casePack}*, minimum order *${v.minOrderQty}*, lead time *${v.leadTimeOverride ? `${v.leadTimeOverride} days` : "from the supplier"}*.\nWhat do you want to change?`,
            list: {
              button: "Change",
              sections: [
                {
                  title: "Rules",
                  rows: [
                    { id: `rrf:${a}:casePack`, title: "Case pack", description: "Order in multiples of" },
                    { id: `rrf:${a}:minOrderQty`, title: "Minimum order quantity" },
                    { id: `rrf:${a}:leadTimeDays`, title: "Lead time for this product" },
                  ],
                },
              ],
            },
          },
        ],
        form: null,
      };
    }

    case "rrf":
      return {
        replies: [{ text: b === "leadTimeDays" ? "Lead time in days for this product? Type a number." : `New ${b === "casePack" ? "case pack" : "minimum order quantity"}? Type a number.`, buttons: [MENU_BTN] }],
        form: { kind: "rules", variantId: gid(a), field: b as "casePack" | "minOrderQty" | "leadTimeDays" },
      };

    case "fc":
      return { replies: [{ text: "Type a product name or SKU to look it up.", buttons: [MENU_BTN] }], form: { kind: "search" } };

    case "po": {
      if (a) return { replies: [await poCard(shop, a)], form: null };
      const counts = await db.purchaseOrder.groupBy({ by: ["status"], where: { shop: shop.id, status: { in: OPEN_STATUSES } }, _count: true });
      const n = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
      const rows = [
        { id: "pol:DRAFT", title: "Drafts", description: `${n("DRAFT")} waiting for approval` },
        { id: "pol:APPROVED", title: "Approved", description: `${n("APPROVED")} ready to send` },
        { id: "pol:SENT", title: "Sent", description: `${n("SENT")} on the way` },
        { id: "pol:PARTIAL", title: "Partly received", description: `${n("PARTIAL")} still expected` },
      ];
      return { replies: [{ header: "Purchase orders", text: "Which purchase orders do you want to see?", list: { button: "Choose", sections: [{ title: "Status", rows }] } }], form: null };
    }

    case "pol": {
      const pos = await db.purchaseOrder.findMany({ where: { shop: shop.id, status: a }, include: { lines: true, supplier: true }, orderBy: { createdAt: "desc" }, take: 10 });
      if (!pos.length) return { replies: [{ text: `No ${a.toLowerCase()} purchase orders.`, buttons: [{ id: "po", title: "Purchase orders" }, MENU_BTN] }], form: null };
      return {
        replies: [
          {
            text: `${a === "PARTIAL" ? "Partly received" : a.charAt(0) + a.slice(1).toLowerCase()} purchase orders`,
            list: {
              button: "Open",
              sections: [{ title: "Purchase orders", rows: pos.map((p) => ({ id: `po:${p.id}`, title: cut(`${p.number} ${p.supplier.name}`, 24), description: `${p.lines.length} lines, ${fmt(poTotal(p.lines))}` })) }],
            },
          },
        ],
        form: null,
      };
    }

    case "poa":
    case "pos":
    case "por": {
      const type: ActionType = head === "poa" ? "APPROVE_PO" : head === "pos" ? "SEND_PO" : "RECEIVE_PO";
      return { replies: [(await propose(shop.id, link.phone, type, { poId: a })).reply], form: null };
    }

    case "sup": {
      if (a === "add") return { replies: [{ text: "Let's add a supplier.\nWhat is the supplier's *name*?", buttons: [MENU_BTN] }], form: { kind: "newSupplier", step: "name", data: {} } };
      if (a) return { replies: [await supplierCard(shop, a)], form: null };
      const suppliers = await db.supplier.findMany({ where: { shop: shop.id }, orderBy: { name: "asc" }, take: PAGE });
      const stats = await leadTimeStats(shop.id);
      const rows: WaRow[] = suppliers.map((s) => ({
        id: `sup:${s.id}`,
        title: cut(s.name, 24),
        description: `${num(stats.get(s.id)?.effective ?? s.defaultLeadTimeDays, 0)} days lead time${s.categoryKey ? ` · ${s.categoryKey.split(",").slice(0, 2).join(", ")}` : ""}`,
      }));
      rows.push({ id: "sup:add", title: "Add a supplier" });
      return { replies: [{ header: "Suppliers", text: suppliers.length ? "Pick a supplier to see or change its details." : "No suppliers yet.", list: { button: "Suppliers", sections: [{ title: "Suppliers", rows }] } }], form: null };
    }

    case "se":
      return {
        replies: [{ text: b === "email" ? "New order email for this supplier?" : b === "phone" ? "New phone number for this supplier?" : "New lead time in days? Type a number.", buttons: [MENU_BTN] }],
        form: { kind: "supplierEdit", supplierId: a, field: b as "email" | "leadTimeDays" | "phone" },
      };

    case "al": {
      if (a) {
        const al = await db.alert.findFirst({ where: { id: a, shop: shop.id } });
        if (!al) return { replies: [{ text: "Alert not found.", buttons: [MENU_BTN] }] };
        return {
          replies: [
            {
              header: cut(al.title, 60),
              text: `${al.message}${al.revenueAtRisk > 0 ? `\n${fmt(al.revenueAtRisk)} at risk.` : ""}`,
              buttons: [
                ...(al.variantId && ["STOCKOUT_RISK", "REORDER_POINT", "VELOCITY_SHIFT"].includes(al.type) ? [{ id: `rv:${shortId(al.variantId)}`, title: "Reorder" }] : []),
                ...(al.status === "OPEN" ? [{ id: `ald:${al.id}`, title: "Dismiss" }] : []),
                MENU_BTN,
              ],
            },
          ],
          form: null,
        };
      }
      const alerts = await db.alert.findMany({ where: { shop: shop.id, status: "OPEN" }, orderBy: [{ revenueAtRisk: "desc" }, { createdAt: "desc" }], take: 10 });
      if (!alerts.length) return { replies: [{ text: "No open alerts.", buttons: [MENU_BTN] }], form: null };
      return {
        replies: [
          {
            header: "Alerts",
            text: `${alerts.length} open alert${alerts.length === 1 ? "" : "s"}, most at risk first.`,
            list: { button: "Open alert", sections: [{ title: "Open", rows: alerts.map((x) => ({ id: `al:${x.id}`, title: cut(x.title, 24), description: cut(x.message, 72) })) }] },
          },
        ],
        form: null,
      };
    }

    case "ald":
      return { replies: [(await propose(shop.id, link.phone, "DISMISS_ALERT", { alertId: a })).reply], form: null };

    case "tr": {
      if (!hasFeature(shop.plan, "transfers")) return { replies: [{ text: "Transfer suggestions are on the Pro plan.", buttons: [MENU_BTN] }], form: null };
      if (a) {
        // tr:<variant>:<from>:<to>:<qty>
        const p = await propose(shop.id, link.phone, "CREATE_TRANSFER", {
          fromLocationId: `gid://shopify/Location/${b}`,
          toLocationId: `gid://shopify/Location/${c}`,
          lines: [{ variantId: gid(a), quantity: Number(d) }],
        });
        return { replies: [p.reply], form: null };
      }
      const s = (await transferSuggestions(shop.id)).slice(0, 10);
      if (!s.length) return { replies: [{ text: "No transfers needed right now.", buttons: [MENU_BTN] }], form: null };
      return {
        replies: [
          {
            header: "Transfers",
            text: "Move stock from a location with too much to one about to run short. Pick one to create a draft transfer.",
            list: {
              button: "Transfers",
              sections: [
                {
                  title: "Suggested",
                  rows: s.map((t) => ({
                    id: `tr:${shortId(t.variantId)}:${shortId(t.fromLocationId)}:${shortId(t.toLocationId)}:${t.quantity}`,
                    title: cut(t.label, 24),
                    description: `${t.quantity} from ${t.fromName} to ${t.toName}`,
                  })),
                },
              ],
            },
          },
        ],
        form: null,
      };
    }

    case "ai":
      return {
        replies: [{ text: "Ask me anything about your stock, sales, suppliers or orders. For example:\n- What runs out before Black Friday?\n- Which supplier is getting slower?\n- Draft an order for everything from Cedar & Co." }],
        form: { kind: "ai" },
      };

    case "set": {
      return {
        replies: [
          {
            header: "Settings and help",
            text: [
              `This number is connected to *${shop.name ?? shop.id}*${link.canApprove ? " and can approve changes" : " as read only"}.`,
              "",
              "- Type *menu* any time for the main menu.",
              "- Type a question to ask StockSense AI.",
              "- Every change shows Approve and Cancel buttons first. Nothing can be deleted from WhatsApp.",
              "- Alert settings and connected numbers are in the app: Settings, WhatsApp.",
            ].join("\n"),
            buttons: [
              ...((await db.whatsappLink.count({ where: { phone: link.phone } })) > 1 ? [{ id: "sw", title: "Switch store" }] : []),
              { id: "unlink", title: "Disconnect" },
              MENU_BTN,
            ],
          },
        ],
        form: null,
      };
    }

    case "unlink":
      if (a === "yes") {
        // Only this store is disconnected; other stores on the same phone stay connected.
        await db.whatsappLink.delete({ where: { id: link.id } });
        const left = await db.whatsappLink.count({ where: { phone: link.phone } });
        return {
          replies: [{ text: `This number is disconnected from *${shop.name ?? shop.id}*.${left ? " Type *menu* to use your other store." : " Connect it again from the app any time."}` }],
          form: null,
        };
      }
      return { replies: [{ text: `Disconnect this number from *${shop.name ?? shop.id}*?`, buttons: [{ id: "unlink:yes", title: "Yes, disconnect" }, MENU_BTN] }], form: null };
  }
  return { replies: [mainMenu(shop)], form: null };
}

// ---------- Typed input for a form in progress ----------

async function formInput(shop: Shop, link: Link, form: Form, text: string): Promise<Handled> {
  const number = () => {
    const n = Number(text.replace(/[, ]/g, ""));
    if (!Number.isFinite(n) || n < 0) throw new ActionError("Please type a number, or type *menu* to go back.");
    return n;
  };
  switch (form.kind) {
    case "search":
      return { replies: [await searchResults(shop, text)], form: { kind: "search" } };
    case "qty": {
      const p = await propose(shop.id, link.phone, "CREATE_DRAFT_PO", { supplierId: form.supplierId, lines: [{ variantId: form.variantId, quantity: number() }] });
      return { replies: [p.reply], form: null };
    }
    case "rules": {
      const p = await propose(shop.id, link.phone, "UPDATE_REORDER_RULES", { variantId: form.variantId, [form.field]: number() });
      return { replies: [p.reply], form: null };
    }
    case "supplierEdit": {
      const value = form.field === "leadTimeDays" ? number() : text;
      const p = await propose(shop.id, link.phone, "UPDATE_SUPPLIER", { supplierId: form.supplierId, [form.field]: value });
      return { replies: [p.reply], form: null };
    }
    case "newSupplier": {
      if (form.step === "name") {
        if (!text) throw new ActionError("Please type the supplier's name.");
        return { replies: [{ text: `*${text}*. What is their order email? Type *skip* if you don't have one.` }], form: { ...form, step: "email", data: { name: text } } };
      }
      if (form.step === "email") {
        const email = /^skip$/i.test(text) ? "" : text;
        return { replies: [{ text: "How many days do they usually take to deliver? Type a number." }], form: { ...form, step: "lead", data: { ...form.data, email } } };
      }
      const p = await propose(shop.id, link.phone, "ADD_SUPPLIER", { name: form.data.name, email: form.data.email, leadTimeDays: number() });
      return { replies: [p.reply], form: null };
    }
  }
  return { replies: [mainMenu(shop)], form: null };
}

// ---------- Free text: Ask StockSense, or a product search when AI is off ----------

async function freeText(shop: Shop, link: Link, text: string): Promise<Handled> {
  if (!text) return { replies: [mainMenu(shop)] };
  if (!process.env.ANTHROPIC_API_KEY) return { replies: [await searchResults(shop, text)] };
  try {
    const res = await ask(shop.id, text, link.threadId ?? undefined, { channel: "whatsapp", phone: link.phone });
    if (res.threadId !== link.threadId) await db.whatsappLink.update({ where: { id: link.id }, data: { threadId: res.threadId } });
    const replies: WaReply[] = [];
    for (const chart of res.charts.slice(0, 2)) {
      try {
        if (chart.kind === "series") {
          replies.push({ text: chart.spec.title ?? "Chart", imageUrl: await publishImage(shop.id, renderPng(seriesSvg(chart.spec))) });
        } else {
          const zero = chart.future.findIndex((x) => x <= 0);
          const svg = stockSvg({
            label: chart.title,
            past: [...chart.past, chart.now],
            future: chart.future,
            futureLow: chart.future,
            futureHigh: chart.future,
            reorderPoint: chart.reorderPoint,
            leadTimeDay: chart.leadTimeDay,
            zeroDay: zero >= 0 ? zero + 1 : null,
            today: chart.today,
          });
          replies.push({ text: chart.title, imageUrl: await publishImage(shop.id, renderPng(svg)) });
        }
      } catch (err) {
        console.warn("[stocksense] whatsapp chart failed", err);
      }
    }
    replies.push({ text: res.answer, ...(res.proposals.length ? {} : { buttons: [MENU_BTN] }) });
    for (const p of res.proposals) replies.push(p.reply);
    return { replies };
  } catch (err) {
    if (err instanceof AskQuotaError) return { replies: [{ text: `${err.message} The menu still works.`, buttons: [MENU_BTN] }] };
    throw err;
  }
}

async function searchResults(shop: Shop, query: string): Promise<WaReply> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const variants = (await db.variant.findMany({ where: { shop: shop.id } }))
    .filter((v) => words.every((w) => `${v.productTitle} ${v.variantTitle ?? ""} ${v.sku ?? ""} ${v.vendor ?? ""}`.toLowerCase().includes(w)))
    .slice(0, 10);
  if (!variants.length) return { text: `No products match "${query}". Try another name or SKU, or type *menu*.` };
  return {
    text: `${variants.length} match${variants.length === 1 ? "" : "es"} for "${query}".`,
    list: { button: "Choose product", sections: [{ title: "Products", rows: variants.map((v) => ({ id: `fv:${shortId(v.id)}`, title: cut(variantLabel(v), 24), description: v.sku ?? undefined })) }] },
  };
}

// ---------- Cards ----------

async function variantMap(ids: string[]) {
  return new Map((await db.variant.findMany({ where: { id: { in: ids } } })).map((v) => [v.id, v]));
}

/** How many to order from each supplier for one product, using the forecast. */
async function supplierOptions(shop: Shop, variantId: string) {
  const [v, f, suppliers, stats] = await Promise.all([
    db.variant.findFirst({ where: { id: variantId, shop: shop.id } }),
    db.forecast.findUnique({ where: { variantId_locationId: { variantId, locationId: "" } } }),
    db.supplier.findMany({ where: { shop: shop.id }, orderBy: { name: "asc" } }),
    leadTimeStats(shop.id),
  ]);
  if (!v) return [];
  const mean: number[] = f ? (JSON.parse(f.series) as number[]) : [0];
  return suppliers
    .map((s) => {
      const st = stats.get(s.id);
      const lead = v.leadTimeOverride ?? st?.effective ?? s.defaultLeadTimeDays;
      const b = orderBreakdown({
        mean: mean.length ? mean : [0],
        sigmaDaily: f?.sigmaDaily ?? 0,
        onHand: f?.onHand ?? 0,
        onOrder: f?.onOrder ?? 0,
        leadTimeDays: lead,
        leadTimeStdDays: v.leadTimeOverride ? lead * 0.15 : (st?.std ?? lead * 0.2),
        serviceLevel: shop.serviceLevel,
        coverageDays: shop.coverageDays,
        casePack: v.casePack,
        minOrderQty: v.minOrderQty,
      });
      return { id: s.id, name: s.name, lead, qty: b.suggested, current: s.id === v.supplierId };
    })
    .sort((x, y) => Number(y.current) - Number(x.current) || x.lead - y.lead);
}

async function productCard(shop: Shop, variantId: string, forReorder: boolean): Promise<WaReply[]> {
  const v = await db.variant.findFirst({ where: { id: variantId, shop: shop.id }, include: { supplier: true } });
  const f = await db.forecast.findUnique({ where: { variantId_locationId: { variantId, locationId: "" } } });
  if (!v) return [{ text: "Product not found.", buttons: [MENU_BTN] }];
  const fmt = (n: number) => money(n, shop.currency);
  const today = todayIn(shop.timezone);
  const replies: WaReply[] = [];
  const curve = f ? await stockCurve(shop.id, variantId, { pastDays: 14, minFuture: 21, maxFuture: 60 }) : null;
  let imageUrl: string | undefined;
  if (curve) {
    try {
      imageUrl = await publishImage(shop.id, renderPng(stockSvg(curve)));
    } catch (err) {
      console.warn("[stocksense] whatsapp chart failed", err);
    }
  }
  const sid = shortId(v.id);
  if (!f || f.status === "NO_DATA") {
    replies.push({
      header: cut(variantLabel(v), 60),
      text: `No sales yet, so there is no forecast.\nOn hand: *${num(f?.onHand ?? 0)}*.`,
      buttons: [{ id: `rq:${sid}:${v.supplierId ?? ""}`, title: "Order anyway" }, MENU_BTN],
    });
    return replies;
  }
  const arrives = shortDate(addDays(today, Math.ceil(f.leadTimeDays)));
  const lines = [
    `${STATUS_LABEL[f.status] ?? f.status} · ${f.confidence.toLowerCase()} confidence`,
    `On hand *${num(f.onHand)}*${f.onOrder ? ` (+${num(f.onOrder)} on order)` : ""}`,
    `Sells *${num(f.meanDaily, 1)}* a day, *${num(f.daysOfCover)}* days of cover`,
    f.stockoutDate ? `Runs out *${shortDate(f.stockoutDate)}*` : null,
    `Supplier *${v.supplier?.name ?? "not set"}*, an order today arrives *${arrives}*`,
    f.suggestedQty > 0 ? `Suggested order *${num(f.suggestedQty)}* units (${fmt(f.suggestedQty * (v.unitCost ?? 0))})` : "No order needed yet",
    f.revenueAtRisk > 0 ? `${fmt(f.revenueAtRisk)} of sales at risk` : null,
  ].filter(Boolean);
  replies.push({
    header: cut(variantLabel(v), 60),
    text: lines.join("\n"),
    imageUrl,
    buttons:
      forReorder || f.suggestedQty > 0
        ? [
            ...(f.suggestedQty > 0 && v.supplierId ? [{ id: `ord:${sid}:${v.supplierId}:${f.suggestedQty}`, title: cut(`Order ${f.suggestedQty}`, 20) }] : []),
            { id: `rq:${sid}:${v.supplierId ?? ""}`, title: "Other quantity" },
            { id: `rs:${sid}`, title: "Compare suppliers" },
          ]
        : [{ id: `rs:${sid}`, title: "Compare suppliers" }, { id: `rr:${sid}`, title: "Reorder rules" }, MENU_BTN],
  });
  return replies;
}

async function poCard(shop: Shop, poId: string): Promise<WaReply> {
  const po = await db.purchaseOrder.findFirst({ where: { id: poId, shop: shop.id }, include: { lines: true, supplier: true } });
  if (!po) return { text: "Purchase order not found.", buttons: [MENU_BTN] };
  const variants = await variantMap(po.lines.map((l) => l.variantId));
  const fmt = (n: number) => money(n, shop.currency);
  const lines = po.lines.slice(0, 8).map((l) => {
    const v = variants.get(l.variantId);
    return `- ${num(l.quantity)} × ${v ? variantLabel(v) : "item"}${l.receivedQty ? ` (${num(l.receivedQty)} received)` : ""}`;
  });
  const more = po.lines.length > 8 ? `\n+${po.lines.length - 8} more lines` : "";
  const next =
    po.status === "DRAFT"
      ? [{ id: `poa:${po.id}`, title: "Approve" }]
      : po.status === "APPROVED"
        ? [{ id: `pos:${po.id}`, title: "Send to supplier" }]
        : po.status === "SENT" || po.status === "PARTIAL"
          ? [{ id: `por:${po.id}`, title: "Receive all" }]
          : [];
  return {
    header: `${po.number} · ${po.status.toLowerCase()}`,
    text: `*${po.supplier.name}*\n${lines.join("\n")}${more}\nTotal *${fmt(poTotal(po.lines))}*${po.expectedAt ? `\nExpected ${shortDate(po.expectedAt.toISOString().slice(0, 10))}` : ""}${
      po.status === "DRAFT" ? "\nTo change quantities, open it in the app or ask StockSense AI." : ""
    }`,
    buttons: [...next, { id: "po", title: "Purchase orders" }, MENU_BTN],
  };
}

async function supplierCard(shop: Shop, supplierId: string): Promise<WaReply> {
  const s = await db.supplier.findFirst({ where: { id: supplierId, shop: shop.id } });
  if (!s) return { text: "Supplier not found.", buttons: [MENU_BTN] };
  const [stats, skus, open] = await Promise.all([
    leadTimeStats(shop.id),
    db.variant.count({ where: { shop: shop.id, supplierId: s.id } }),
    db.purchaseOrder.count({ where: { shop: shop.id, supplierId: s.id, status: { in: OPEN_STATUSES } } }),
  ]);
  const st = stats.get(s.id);
  return {
    header: cut(s.name, 60),
    text: [
      `Lead time *${num(st?.effective ?? s.defaultLeadTimeDays, 1)} days*${st?.observations ? ` (from ${st.observations} deliveries)` : ""}`,
      `Email ${s.email ?? "not set"}`,
      `Phone ${s.phone ?? "not set"}`,
      s.minOrderValue > 0 ? `Minimum order ${money(s.minOrderValue, shop.currency)}` : null,
      s.categoryKey ? `Preferred for ${s.categoryKey.split(",").join(", ")}` : null,
      `${skus} product${skus === 1 ? "" : "s"}, ${open} open purchase order${open === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join("\n"),
    list: {
      button: "Change",
      sections: [
        {
          title: "Change",
          rows: [
            { id: `se:${s.id}:leadTimeDays`, title: "Lead time" },
            { id: `se:${s.id}:email`, title: "Order email" },
            { id: `se:${s.id}:phone`, title: "Phone" },
            { id: "sup", title: "All suppliers" },
            { id: "menu", title: "Main menu" },
          ],
        },
      ],
    },
  };
}
