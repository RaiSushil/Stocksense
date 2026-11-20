// Extra tools for Ask StockSense on WhatsApp. The AI can read anything it can read in
// the app, but it cannot change data: propose_change stores a proposal that the
// merchant approves with a button. There is no tool to delete or cancel anything.

import type Anthropic from "@anthropic-ai/sdk";
import db from "../../db.server";
import { money, variantLabel } from "../format";
import { poTotal } from "../po.server";
import { ACTION_TYPES, ActionError, propose, type ActionType } from "./actions.server";
import type { WaReply } from "./provider.server";

export const WHATSAPP_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_purchase_orders",
    description: "Purchase orders with their status, supplier, lines and totals. Status: DRAFT, APPROVED, SENT, PARTIAL, RECEIVED or CANCELLED.",
    input_schema: { type: "object", properties: { status: { type: "string" } } },
  },
  {
    name: "list_alerts",
    description: "Open alerts (stockout risk, reorder point, velocity shift, lead time drift, overstock), most urgent first.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_change",
    description: `Propose a change for the merchant to approve. Nothing changes until they tap Approve; never say a change is done.
Deleting, cancelling or removing anything is not possible.
Types and their input:
- CREATE_DRAFT_PO: { supplierId?, lines: [{ variantId, quantity? }], notes?, addToPoId? } (quantity defaults to the suggested order)
- APPROVE_PO: { poId }
- SEND_PO: { poId, emailSupplier? } (emails the supplier; the merchant confirms twice)
- RECEIVE_PO: { poId } (receives everything still expected and adds it to Shopify stock)
- ADD_SUPPLIER: { name, email?, phone?, contactName?, leadTimeDays, minOrderValue?, paymentTerms?, vendors?: string[], categories?: string[] }
- UPDATE_SUPPLIER: { supplierId, email?, phone?, contactName?, leadTimeDays?, minOrderValue?, paymentTerms? }
- SET_PREFERRED_SUPPLIER: { variantId, supplierId, forCategory? } (forCategory applies it to the product's whole category)
- UPDATE_REORDER_RULES: { variantId, casePack?, minOrderQty?, leadTimeDays? }
- DISMISS_ALERT: { alertId }
- CREATE_TRANSFER: { fromLocationId, toLocationId, lines: [{ variantId, quantity }] }
Use ids exactly as returned by other tools.`,
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...ACTION_TYPES] },
        input: { type: "object" },
      },
      required: ["type", "input"],
    },
  },
];

export interface WhatsappToolContext {
  shop: string;
  phone: string;
  proposals: { id: string; summary: string; reply: WaReply }[];
}

export async function runWhatsappTool(name: string, input: any, ctx: WhatsappToolContext): Promise<unknown> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: ctx.shop } });
  switch (name) {
    case "list_purchase_orders": {
      const pos = await db.purchaseOrder.findMany({
        where: { shop: ctx.shop, ...(input?.status ? { status: String(input.status).toUpperCase() } : {}) },
        include: { lines: true, supplier: true },
        orderBy: { createdAt: "desc" },
        take: 15,
      });
      const variants = new Map((await db.variant.findMany({ where: { id: { in: pos.flatMap((p) => p.lines.map((l) => l.variantId)) } } })).map((v) => [v.id, v]));
      return pos.map((p) => ({
        po_id: p.id,
        number: p.number,
        status: p.status,
        supplier: p.supplier.name,
        supplier_id: p.supplierId,
        total: money(poTotal(p.lines), shop.currency),
        expected: p.expectedAt?.toISOString().slice(0, 10) ?? null,
        lines: p.lines.map((l) => ({ variant_id: l.variantId, name: variants.get(l.variantId) ? variantLabel(variants.get(l.variantId)!) : l.variantId, quantity: l.quantity, received: l.receivedQty })),
      }));
    }
    case "list_alerts": {
      const alerts = await db.alert.findMany({ where: { shop: ctx.shop, status: "OPEN" }, orderBy: [{ revenueAtRisk: "desc" }, { createdAt: "desc" }], take: 15 });
      return alerts.map((a) => ({ alert_id: a.id, type: a.type, severity: a.severity, title: a.title, message: a.message, variant_id: a.variantId, revenue_at_risk: a.revenueAtRisk }));
    }
    case "propose_change": {
      if (ctx.proposals.length >= 3) return { error: "Propose at most three changes at a time." };
      const type = String(input?.type) as ActionType;
      try {
        const p = await propose(ctx.shop, ctx.phone, type, input?.input ?? {}, "AI");
        ctx.proposals.push(p);
        return { proposed: true, summary: p.summary, note: "The merchant sees Approve and Cancel buttons under your reply." };
      } catch (err) {
        if (err instanceof ActionError) return { error: err.message };
        throw err;
      }
    }
  }
  throw new Error(`Unknown tool ${name}`);
}
