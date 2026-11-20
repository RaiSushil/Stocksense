// Changes requested on WhatsApp, by menu or by the AI.
//
// Nothing here changes data when it is proposed. A proposal is stored with the exact
// data it will use and shown to the merchant with Approve and Cancel buttons; only
// an approval from a linked phone that may approve runs it, once, after checking it
// again. Only the action types listed in RUNNERS exist: there is no way to delete or
// cancel anything from WhatsApp.

import crypto from "node:crypto";
import db from "../../db.server";
import { addDays, shortDate, todayIn } from "../dates";
import { money, num, variantLabel } from "../format";
import { hasFeature } from "../plans";
import { approvePo, createDraftPo, OPEN_STATUSES, poTotal, receivePo, sendPo } from "../po.server";
import { leadTimeStats } from "../suppliers.server";
import { keyList, readSupplierForm, saveSupplier, setPreferredForCategories, supplierToValues, validateSupplier } from "../supplier-form.server";
import { createTransfer } from "../transfers.server";
import { offlineAdmin } from "../shopify/admin.server";
import { inBackground, runPartialRefresh, runRebuild } from "../jobs.server";
import type { WaReply } from "./provider.server";

export const ACTION_TYPES = [
  "CREATE_DRAFT_PO",
  "APPROVE_PO",
  "SEND_PO",
  "RECEIVE_PO",
  "ADD_SUPPLIER",
  "UPDATE_SUPPLIER",
  "SET_PREFERRED_SUPPLIER",
  "UPDATE_REORDER_RULES",
  "DISMISS_ALERT",
  "CREATE_TRANSFER",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** How long a proposal can be approved for. */
export const ACTION_TTL_MS = 30 * 60_000;

export class ActionError extends Error {}

interface Prepared {
  payload: Record<string, unknown>;
  summary: string;
  /** Sending a PO emails someone outside the store, so it needs a second yes. */
  confirmTwice?: boolean;
}

type Shop = { id: string; plan: string; currency: string; timezone: string; defaultLeadTimeDays: number; name: string | null };

const int = (v: unknown, min: number, max: number, label: string) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new ActionError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

function needPlan(shop: Shop, feature: Parameters<typeof hasFeature>[1], what: string) {
  if (!hasFeature(shop.plan, feature)) throw new ActionError(`${what} is not included in your plan.`);
}

// ---------- Preparing: check everything and write the summary the merchant approves ----------

async function prepare(shop: Shop, type: ActionType, input: any): Promise<Prepared> {
  const fmt = (n: number) => money(n, shop.currency);
  switch (type) {
    case "CREATE_DRAFT_PO": {
      needPlan(shop, "draftPurchaseOrders", "Draft purchase orders");
      const raw: { variantId: string; quantity?: number }[] = Array.isArray(input?.lines) ? input.lines : [];
      if (!raw.length) throw new ActionError("Choose at least one product.");
      const variants = await db.variant.findMany({ where: { shop: shop.id, id: { in: raw.map((l) => String(l.variantId)) } } });
      if (variants.length !== new Set(raw.map((l) => String(l.variantId))).size) throw new ActionError("One of those products was not found.");
      const supplierId = String(input?.supplierId || variants[0].supplierId || "");
      const supplier = supplierId ? await db.supplier.findFirst({ where: { id: supplierId, shop: shop.id } }) : null;
      if (!supplier) throw new ActionError("Choose a supplier for this order.");
      const forecasts = new Map(
        (await db.forecast.findMany({ where: { shop: shop.id, locationId: "", variantId: { in: variants.map((v) => v.id) } } })).map((f) => [f.variantId, f]),
      );
      const lines = raw.map((l) => {
        const v = variants.find((x) => x.id === String(l.variantId))!;
        const suggested = forecasts.get(v.id)?.suggestedQty ?? 0;
        const qty = l.quantity === undefined || l.quantity === null ? suggested : Number(l.quantity);
        if (!qty) throw new ActionError(`No suggested quantity for ${variantLabel(v)}. Give a quantity.`);
        return { variantId: v.id, quantity: int(qty, 1, 100_000, "Quantity"), unitCost: v.unitCost ?? 0, label: variantLabel(v) };
      });
      let addToPoId: string | null = null;
      if (input?.addToPoId) {
        const draft = await db.purchaseOrder.findFirst({ where: { id: String(input.addToPoId), shop: shop.id, status: "DRAFT", supplierId: supplier.id } });
        if (!draft) throw new ActionError("That draft is no longer open for this supplier.");
        addToPoId = draft.id;
      }
      const lead = (await leadTimeStats(shop.id)).get(supplier.id)?.effective ?? supplier.defaultLeadTimeDays;
      const total = poTotal(lines);
      const target = addToPoId ? `Add to draft ${(await db.purchaseOrder.findUnique({ where: { id: addToPoId } }))?.number}` : "New draft purchase order";
      return {
        payload: { supplierId: supplier.id, lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost })), addToPoId, notes: input?.notes ? String(input.notes).slice(0, 500) : null },
        summary: [
          `*${target}* for *${supplier.name}*`,
          ...lines.map((l) => `• ${num(l.quantity)} × ${l.label} (${fmt(l.quantity * l.unitCost)})`),
          `Total *${fmt(total)}*, expected around ${shortDate(addDays(todayIn(shop.timezone), Math.ceil(lead)))}.`,
          supplier.minOrderValue > 0 && total < supplier.minOrderValue ? `Below ${supplier.name}'s minimum order of ${fmt(supplier.minOrderValue)}.` : null,
          "Nothing is sent to the supplier.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "APPROVE_PO": {
      needPlan(shop, "draftPurchaseOrders", "Purchase orders");
      const po = await db.purchaseOrder.findFirst({ where: { id: String(input?.poId), shop: shop.id }, include: { lines: true, supplier: true } });
      if (!po) throw new ActionError("Purchase order not found.");
      if (po.status !== "DRAFT") throw new ActionError(`${po.number} is ${po.status.toLowerCase()}, not a draft.`);
      if (!po.lines.length) throw new ActionError(`${po.number} has no lines.`);
      return {
        payload: { poId: po.id },
        summary: `*Approve ${po.number}* for ${po.supplier.name}: ${po.lines.length} line${po.lines.length === 1 ? "" : "s"}, ${fmt(poTotal(po.lines))}.\nIt is not sent until you send it.`,
      };
    }
    case "SEND_PO": {
      needPlan(shop, "draftPurchaseOrders", "Purchase orders");
      const po = await db.purchaseOrder.findFirst({ where: { id: String(input?.poId), shop: shop.id }, include: { lines: true, supplier: true } });
      if (!po) throw new ActionError("Purchase order not found.");
      if (po.status !== "APPROVED") throw new ActionError(`${po.number} must be approved before it is sent.`);
      const email = input?.emailSupplier !== false && !!po.supplier.email;
      return {
        payload: { poId: po.id, emailSupplier: email },
        summary: email
          ? `*Send ${po.number}* to ${po.supplier.name}.\nIt will be emailed to *${po.supplier.email}* with a CSV, ${fmt(poTotal(po.lines))}.`
          : `*Mark ${po.number} as ordered* with ${po.supplier.name}.\nNo email is sent${po.supplier.email ? "" : " (no email on file)"}.`,
        confirmTwice: email,
      };
    }
    case "RECEIVE_PO": {
      needPlan(shop, "draftPurchaseOrders", "Purchase orders");
      const po = await db.purchaseOrder.findFirst({ where: { id: String(input?.poId), shop: shop.id }, include: { lines: true } });
      if (!po) throw new ActionError("Purchase order not found.");
      if (!["APPROVED", "SENT", "PARTIAL"].includes(po.status)) throw new ActionError(`${po.number} cannot be received.`);
      if (!po.locationId) throw new ActionError(`${po.number} has no destination location. Set it in the app first.`);
      const received: Record<string, number> = {};
      for (const l of po.lines) {
        const left = Math.max(0, l.quantity - l.receivedQty);
        if (left > 0) received[l.id] = left;
      }
      const units = Object.values(received).reduce((a, b) => a + b, 0);
      const location = await db.location.findUnique({ where: { id: po.locationId } });
      if (!units) throw new ActionError(`Everything on ${po.number} is already received.`);
      return {
        payload: { poId: po.id, received },
        summary: `*Receive ${po.number} in full*: add ${num(units)} unit${units === 1 ? "" : "s"} to *${location?.name ?? "the destination"}* in Shopify.`,
      };
    }
    case "ADD_SUPPLIER": {
      const f = new FormData();
      f.set("name", String(input?.name ?? ""));
      f.set("email", String(input?.email ?? ""));
      f.set("phone", String(input?.phone ?? ""));
      f.set("contactName", String(input?.contactName ?? ""));
      f.set("leadTime", String(input?.leadTimeDays ?? shop.defaultLeadTimeDays));
      f.set("minOrderValue", String(input?.minOrderValue ?? 0));
      f.set("currency", String(input?.currency ?? shop.currency));
      f.set("paymentTerms", String(input?.paymentTerms ?? ""));
      f.set("notes", String(input?.notes ?? ""));
      for (const v of Array.isArray(input?.vendors) ? input.vendors : []) f.append("vendors", String(v));
      for (const c of Array.isArray(input?.categories) ? input.categories : []) f.append("categories", String(c));
      const values = readSupplierForm(f);
      const errors = await validateSupplier(shop.id, values);
      const first = Object.values(errors)[0];
      if (first) throw new ActionError(first);
      return {
        payload: { values },
        summary: [
          `*Add supplier ${values.name}*`,
          values.email ? `Email: ${values.email}` : null,
          values.phone ? `Phone: ${values.phone}` : null,
          `Lead time: ${values.leadTime} days`,
          Number(values.minOrderValue) > 0 ? `Minimum order: ${fmt(Number(values.minOrderValue))}` : null,
          values.vendors.length ? `Makes: ${values.vendors.join(", ")}` : null,
          values.categories.length ? `Preferred for: ${values.categories.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "UPDATE_SUPPLIER": {
      const s = await db.supplier.findFirst({ where: { id: String(input?.supplierId), shop: shop.id } });
      if (!s) throw new ActionError("Supplier not found.");
      const values = supplierToValues(s);
      const changes: string[] = [];
      // Only fields that are given are changed; nothing can be cleared from WhatsApp.
      for (const [key, label] of [
        ["email", "Email"],
        ["phone", "Phone"],
        ["contactName", "Contact"],
        ["paymentTerms", "Payment terms"],
      ] as const) {
        const v = input?.[key];
        if (typeof v === "string" && v.trim() && v.trim() !== values[key]) {
          values[key] = v.trim();
          changes.push(`${label}: ${v.trim()}`);
        }
      }
      if (input?.leadTimeDays !== undefined && input.leadTimeDays !== null) {
        const d = int(input.leadTimeDays, 1, 365, "Lead time");
        if (String(d) !== values.leadTime) {
          values.leadTime = String(d);
          changes.push(`Lead time: ${d} days`);
        }
      }
      if (input?.minOrderValue !== undefined && input.minOrderValue !== null) {
        const m = Number(input.minOrderValue);
        if (!Number.isFinite(m) || m < 0) throw new ActionError("Minimum order must be 0 or more.");
        values.minOrderValue = String(m);
        changes.push(`Minimum order: ${fmt(m)}`);
      }
      if (!changes.length) throw new ActionError("Nothing to change.");
      const errors = await validateSupplier(shop.id, values, s.id);
      const first = Object.values(errors)[0];
      if (first) throw new ActionError(first);
      return { payload: { supplierId: s.id, values }, summary: `*Update ${s.name}*\n${changes.join("\n")}` };
    }
    case "SET_PREFERRED_SUPPLIER": {
      const v = await db.variant.findFirst({ where: { id: String(input?.variantId), shop: shop.id } });
      const s = await db.supplier.findFirst({ where: { id: String(input?.supplierId), shop: shop.id } });
      if (!v || !s) throw new ActionError("Product or supplier not found.");
      const forCategory = !!input?.forCategory && !!v.productType;
      const count = forCategory ? await db.variant.count({ where: { shop: shop.id, productType: v.productType } }) : 1;
      return {
        payload: { variantId: v.id, supplierId: s.id, forCategory },
        summary: forCategory
          ? `*Use ${s.name}* for all *${v.productType}* products (${count} SKU${count === 1 ? "" : "s"}), including new ones.`
          : `*Use ${s.name}* for ${variantLabel(v)}.`,
      };
    }
    case "UPDATE_REORDER_RULES": {
      const v = await db.variant.findFirst({ where: { id: String(input?.variantId), shop: shop.id } });
      if (!v) throw new ActionError("Product not found.");
      const data: { casePack?: number; minOrderQty?: number; leadTimeOverride?: number } = {};
      const lines: string[] = [];
      if (input?.casePack != null) {
        data.casePack = int(input.casePack, 1, 10_000, "Case pack");
        lines.push(`Case pack: ${data.casePack}`);
      }
      if (input?.minOrderQty != null) {
        data.minOrderQty = int(input.minOrderQty, 0, 100_000, "Minimum order quantity");
        lines.push(`Minimum order: ${data.minOrderQty}`);
      }
      if (input?.leadTimeDays != null) {
        data.leadTimeOverride = int(input.leadTimeDays, 1, 365, "Lead time");
        lines.push(`Lead time: ${data.leadTimeOverride} days`);
      }
      if (!lines.length) throw new ActionError("Nothing to change.");
      return { payload: { variantId: v.id, data }, summary: `*Reorder rules for ${variantLabel(v)}*\n${lines.join("\n")}` };
    }
    case "DISMISS_ALERT": {
      const a = await db.alert.findFirst({ where: { id: String(input?.alertId), shop: shop.id } });
      if (!a) throw new ActionError("Alert not found.");
      if (a.status !== "OPEN") throw new ActionError("That alert is already closed.");
      return { payload: { alertId: a.id }, summary: `*Dismiss alert*: ${a.title}\nYou can reopen it in the app.` };
    }
    case "CREATE_TRANSFER": {
      needPlan(shop, "transfers", "Transfers");
      const from = await db.location.findFirst({ where: { id: String(input?.fromLocationId), shop: shop.id } });
      const to = await db.location.findFirst({ where: { id: String(input?.toLocationId), shop: shop.id } });
      if (!from || !to || from.id === to.id) throw new ActionError("Choose two different locations.");
      const raw: { variantId: string; quantity: number }[] = Array.isArray(input?.lines) ? input.lines : [];
      const variants = new Map((await db.variant.findMany({ where: { shop: shop.id, id: { in: raw.map((l) => String(l.variantId)) } } })).map((v) => [v.id, v]));
      const lines = raw
        .filter((l) => variants.has(String(l.variantId)))
        .map((l) => ({ variantId: String(l.variantId), quantity: int(l.quantity, 1, 100_000, "Quantity") }));
      if (!lines.length) throw new ActionError("Nothing to transfer.");
      return {
        payload: { fromLocationId: from.id, toLocationId: to.id, lines },
        summary: [`*Draft transfer* ${from.name} → ${to.name}`, ...lines.map((l) => `• ${num(l.quantity)} × ${variantLabel(variants.get(l.variantId)!)}`)].join("\n"),
      };
    }
  }
}

// ---------- Running: the only code that changes data ----------

type Runner = (shop: Shop, payload: any) => Promise<{ message: string; next?: WaReply["buttons"] }>;

const RUNNERS: Record<ActionType, Runner> = {
  async CREATE_DRAFT_PO(shop, p) {
    const supplier = await db.supplier.findFirst({ where: { id: p.supplierId, shop: shop.id } });
    if (!supplier) throw new ActionError("The supplier no longer exists.");
    let poId: string;
    if (p.addToPoId) {
      const draft = await db.purchaseOrder.findFirst({ where: { id: p.addToPoId, shop: shop.id, status: "DRAFT" }, include: { lines: true } });
      if (!draft) throw new ActionError("That draft is no longer open.");
      await db.$transaction([
        ...p.lines.map((l: { variantId: string; quantity: number; unitCost: number }) => {
          const line = draft.lines.find((x) => x.variantId === l.variantId);
          return line
            ? db.purchaseOrderLine.update({ where: { id: line.id }, data: { quantity: l.quantity, unitCost: l.unitCost } })
            : db.purchaseOrderLine.create({ data: { poId: draft.id, ...l } });
        }),
        db.purchaseOrder.update({ where: { id: draft.id }, data: { source: "MANUAL" } }),
      ]);
      poId = draft.id;
    } else {
      poId = (await createDraftPo(shop.id, { supplierId: supplier.id, source: "ASK", lines: p.lines, notes: p.notes ?? undefined })).id;
    }
    inBackground("refresh", runPartialRefresh(shop.id, p.lines.map((l: { variantId: string }) => l.variantId)));
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    return { message: `Draft *${po.number}* is ready for ${supplier.name}.`, next: [{ id: `po:${po.id}`, title: `Open ${po.number}` }] };
  },
  async APPROVE_PO(shop, p) {
    const po = await approvePo(shop.id, p.poId);
    return { message: `*${po.number}* is approved.`, next: [{ id: `po:${po.id}`, title: `Open ${po.number}` }] };
  },
  async SEND_PO(shop, p) {
    const { po, emailed } = await sendPo(shop.id, p.poId, p.emailSupplier);
    return { message: `*${po.number}* is marked as ordered${emailed ? " and emailed to the supplier" : ""}.` };
  },
  async RECEIVE_PO(shop, p) {
    const admin = await offlineAdmin(shop.id);
    await receivePo(admin, shop.id, p.poId, p.received);
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: p.poId } });
    return { message: `Stock from *${po.number}* is added in Shopify. Status: ${po.status.toLowerCase()}.` };
  },
  async ADD_SUPPLIER(shop, p) {
    const errors = await validateSupplier(shop.id, p.values);
    const first = Object.values(errors)[0];
    if (first) throw new ActionError(first);
    const id = await saveSupplier(shop.id, p.values);
    if (p.values.categories?.length || p.values.vendors?.length) inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
    return { message: `Supplier *${p.values.name}* is added.`, next: [{ id: `sup:${id}`, title: "Open supplier" }] };
  },
  async UPDATE_SUPPLIER(shop, p) {
    const errors = await validateSupplier(shop.id, p.values, p.supplierId);
    const first = Object.values(errors)[0];
    if (first) throw new ActionError(first);
    await saveSupplier(shop.id, p.values, p.supplierId);
    return { message: `*${p.values.name}* is updated.`, next: [{ id: `sup:${p.supplierId}`, title: "Open supplier" }] };
  },
  async SET_PREFERRED_SUPPLIER(shop, p) {
    const v = await db.variant.findFirstOrThrow({ where: { id: p.variantId, shop: shop.id } });
    await db.variant.update({ where: { id: v.id }, data: { supplierId: p.supplierId } });
    if (p.forCategory && v.productType) {
      await setPreferredForCategories(shop.id, p.supplierId, [v.productType]);
      inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
    } else {
      inBackground("refresh", runPartialRefresh(shop.id, [v.id]));
    }
    return { message: "Preferred supplier saved. Forecasts are recalculating." };
  },
  async UPDATE_REORDER_RULES(shop, p) {
    await db.variant.updateMany({ where: { id: p.variantId, shop: shop.id }, data: p.data });
    inBackground("refresh", runPartialRefresh(shop.id, [p.variantId]));
    return { message: "Reorder rules saved. The suggestion is recalculating." };
  },
  async DISMISS_ALERT(shop, p) {
    const n = await db.alert.updateMany({ where: { id: p.alertId, shop: shop.id, status: "OPEN" }, data: { status: "DISMISSED" } });
    if (!n.count) throw new ActionError("That alert is already closed.");
    return { message: "Alert dismissed. You can reopen it in the app." };
  },
  async CREATE_TRANSFER(shop, p) {
    const admin = await offlineAdmin(shop.id);
    const t = await createTransfer(admin, shop.id, p.fromLocationId, p.toLocationId, p.lines);
    return { message: `Draft transfer *${t.name}* is created in Shopify.` };
  },
};

const hashOf = (type: string, payload: string) => crypto.createHash("sha256").update(`${type}\n${payload}`).digest("hex");

export const approveButtons = (id: string) => [
  { id: `act:ok:${id}`, title: "Approve" },
  { id: `act:no:${id}`, title: "Cancel" },
];

/** Stores a proposal and returns the message asking for approval. Changes nothing else. */
export async function propose(
  shopId: string,
  phone: string,
  type: ActionType,
  input: unknown,
  source: "MENU" | "AI" = "MENU",
): Promise<{ id: string; summary: string; reply: WaReply }> {
  if (!ACTION_TYPES.includes(type)) throw new ActionError("That change is not available on WhatsApp.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  const prepared = await prepare(shop, type, input);
  const payload = JSON.stringify({ ...prepared.payload, __confirmTwice: !!prepared.confirmTwice });
  const action = await db.pendingAction.create({
    data: {
      shop: shopId,
      phone,
      type,
      payload,
      payloadHash: hashOf(type, payload),
      summary: prepared.summary,
      source,
      expiresAt: new Date(Date.now() + ACTION_TTL_MS),
    },
  });
  return {
    id: action.id,
    summary: prepared.summary,
    reply: { header: "Please confirm", text: prepared.summary, footer: "Valid for 30 minutes", buttons: approveButtons(action.id) },
  };
}

/**
 * Approve, confirm or cancel a proposal from a linked phone. Runs the change at most
 * once and reports what happened.
 */
export async function decide(phone: string, actionId: string, decision: "approve" | "confirm" | "cancel"): Promise<WaReply> {
  const action = await db.pendingAction.findUnique({ where: { id: actionId } });
  // A request belongs to one store and one phone; the phone must still be linked to that store.
  const link = action ? await db.whatsappLink.findUnique({ where: { shop_phone: { shop: action.shop, phone } } }) : null;
  if (!action || action.phone !== phone || !link) return { text: "That request was not found." };
  const shopId = action.shop;
  // The store may have uninstalled StockSense or left a plan with WhatsApp since the request was made.
  const owner = await db.shop.findUnique({ where: { id: shopId }, select: { uninstalledAt: true, plan: true } });
  if (!owner || owner.uninstalledAt || !hasFeature(owner.plan, "phoneAlerts")) {
    await db.pendingAction.updateMany({ where: { id: action.id, status: { in: ["PENDING", "CONFIRMING"] } }, data: { status: "CANCELLED", decidedAt: new Date() } });
    return { text: "That store no longer has the WhatsApp assistant, so nothing was changed." };
  }
  if (["DONE", "FAILED", "CANCELLED", "EXPIRED", "RUNNING"].includes(action.status)) {
    return { text: `That request is already ${action.status === "RUNNING" ? "running" : action.status.toLowerCase()}.`, buttons: [{ id: "menu", title: "Main menu" }] };
  }
  if (decision === "cancel") {
    await db.pendingAction.updateMany({ where: { id: action.id, status: { in: ["PENDING", "CONFIRMING"] } }, data: { status: "CANCELLED", decidedAt: new Date() } });
    return { text: "Cancelled. Nothing was changed.", buttons: [{ id: "menu", title: "Main menu" }] };
  }
  if (!link.canApprove) return { text: "This number can view but not approve changes. Ask the store owner to allow it in Settings." };
  if (action.expiresAt < new Date()) {
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "EXPIRED" } });
    return { text: "That request expired. Start it again to see the latest numbers.", buttons: [{ id: "menu", title: "Main menu" }] };
  }
  if (hashOf(action.type, action.payload) !== action.payloadHash) {
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "FAILED", result: "Changed after it was proposed" } });
    return { text: "That request could not be verified, so nothing was changed." };
  }
  const payload = JSON.parse(action.payload);
  if (payload.__confirmTwice && action.status === "PENDING") {
    if (decision !== "approve") return { text: "Approve the request first." };
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "CONFIRMING" } });
    return {
      header: "Final check",
      text: `This sends an email to the supplier and cannot be undone.\n\n${action.summary}`,
      buttons: [
        { id: `act:go:${action.id}`, title: "Send now" },
        { id: `act:no:${action.id}`, title: "Cancel" },
      ],
    };
  }
  if (payload.__confirmTwice && decision !== "confirm") return { text: "Tap Send now to confirm, or Cancel." };

  // Claim it, so a double tap or a redelivered message cannot run it twice.
  const claimed = await db.pendingAction.updateMany({
    where: { id: action.id, status: { in: ["PENDING", "CONFIRMING"] } },
    data: { status: "RUNNING", decidedAt: new Date() },
  });
  if (!claimed.count) return { text: "That request is already being handled." };

  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  const runner = RUNNERS[action.type as ActionType];
  if (!runner) {
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "FAILED", result: "Not allowed" } });
    return { text: "That change is not available on WhatsApp." };
  }
  try {
    const clean = { ...payload };
    delete clean.__confirmTwice;
    const out = await runner(shop, clean);
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "DONE", result: out.message.replace(/\*/g, "") } });
    return { text: out.message, buttons: [...(out.next ?? []), { id: "menu", title: "Main menu" }].slice(0, 3) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Something went wrong";
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "FAILED", result: msg.slice(0, 500) } });
    return { text: `Not done: ${msg}`, buttons: [{ id: "menu", title: "Main menu" }] };
  }
}

/** Open proposals older than their window are marked expired (for the action log). */
export async function expireOld() {
  await db.pendingAction.updateMany({ where: { status: { in: ["PENDING", "CONFIRMING"] }, expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
}

export { OPEN_STATUSES, keyList };
