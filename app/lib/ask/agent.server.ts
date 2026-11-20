// "Ask StockSense": plain-English questions answered by Claude, grounded in the
// shop's own data through tool calls.

import Anthropic from "@anthropic-ai/sdk";
import db from "../../db.server";
import { todayIn } from "../dates";
import { planDef } from "../plans";
import { ASK_TOOLS, runTool, type AskChart, type ToolContext } from "./tools.server";
import { runWhatsappTool, WHATSAPP_TOOLS, type WhatsappToolContext } from "../whatsapp/ai-tools.server";
import type { WaReply } from "../whatsapp/provider.server";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const MAX_TOOL_ROUNDS = 8;

export class AskQuotaError extends Error {}

export function askQuota(plan: string) {
  return planDef(plan)?.askQuota ?? 0;
}

function systemPrompt(shop: { name: string | null; currency: string; timezone: string }) {
  return `You are StockSense, an inventory analyst for the Shopify store "${shop.name ?? "this store"}".
Today is ${todayIn(shop.timezone)} (${shop.timezone}). Money is in ${shop.currency}.

Rules:
- Answer only from tool results. Never invent products, numbers, dates or suppliers. If the data does not answer the question, say what is missing.
- Use the tools before answering any question about stock, sales, forecasts, suppliers or orders.
- Lead with the direct answer in one sentence, then the supporting numbers. Keep it short.
- Name variants as "Product / Variant". Give days of cover, stockout dates and lead times when relevant.
- When something will run out, say whether an order placed today arrives in time (compare lead time with days of cover) and what the alternative is (expedite, cap quantity, transfer stock).
- Only call draft_purchase_order when the user asks you to draft or create an order. Drafts are never sent; tell the user it is waiting for their approval.
- When an answer compares several items or shows a trend, call show_chart with the exact numbers from the tool results, then refer to the chart in one short sentence. Calling variant_detail already attaches that SKU's stock curve.
- Format: short paragraphs, "- " bullet lines and **bold** for the key figures. No headings or tables.`;
}

export interface AskResult {
  threadId: string;
  answer: string;
  poIds: string[];
  charts: AskChart[];
  /** WhatsApp only: changes waiting for the merchant's approval. */
  proposals: { id: string; summary: string; reply: WaReply }[];
}

/** Where the question came from. On WhatsApp the AI proposes changes instead of making them. */
export interface AskOptions {
  channel?: "app" | "whatsapp";
  phone?: string;
}

const WHATSAPP_RULES = `
You are replying on WhatsApp.
- You cannot change anything yourself. To change data, call propose_change; the merchant approves it with a button under your reply. Never say a change is done.
- You cannot delete, cancel or remove anything. If asked, say it has to be done in the StockSense app.
- Write for a phone screen: at most about 700 characters, *single asterisks* for bold, "- " bullets, no headings, no tables, no links.
- When you propose something, say in one line what it will do and that they can tap Approve.`;

export async function ask(shop: string, question: string, threadId?: string, opts: AskOptions = {}): Promise<AskResult> {
  const whatsapp = opts.channel === "whatsapp" && !!opts.phone;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  const quota = askQuota(shopRow.plan);
  if (quota <= 0) throw new AskQuotaError("Ask your inventory is available on the Scale and Pro plans.");
  if (shopRow.askQuestionsUsed >= quota) throw new AskQuotaError(`You have used all ${quota} questions this month.`);

  const thread = threadId
    ? await db.askThread.findFirstOrThrow({ where: { id: threadId, shop }, include: { messages: { orderBy: { createdAt: "asc" } } } })
    : await db.askThread.create({ data: { shop, title: whatsapp ? `WhatsApp ${opts.phone}` : question.slice(0, 80) }, include: { messages: true } });

  // Earlier turns are replayed as text so follow-ups ("draft that PO") have context.
  const history: Anthropic.MessageParam[] = thread.messages.slice(-12).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));
  const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: question }];
  await db.askMessage.create({ data: { threadId: thread.id, role: "user", content: question } });

  const client = new Anthropic();
  const ctx: ToolContext = { shop, createdPoIds: [], charts: [] };
  const wctx: WhatsappToolContext = { shop, phone: opts.phone ?? "", proposals: [] };
  // On WhatsApp the AI drafts nothing directly: it proposes, and the merchant approves.
  const tools = whatsapp ? [...ASK_TOOLS.filter((t) => t.name !== "draft_purchase_order"), ...WHATSAPP_TOOLS] : ASK_TOOLS;
  const whatsappToolNames = new Set(WHATSAPP_TOOLS.map((t) => t.name));
  let answer = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt(shopRow) + (whatsapp ? WHATSAPP_RULES : ""),
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (res.stop_reason !== "tool_use" || !toolUses.length) {
      answer = text;
      break;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        if (!tools.some((t) => t.name === tu.name)) throw new Error("That tool is not available here");
        const out = whatsapp && whatsappToolNames.has(tu.name) ? await runWhatsappTool(tu.name, tu.input, wctx) : await runTool(tu.name, tu.input, ctx);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: true,
          content: err instanceof Error ? err.message : "Tool failed",
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
  if (!answer) answer = "I could not finish that analysis. Try asking a narrower question.";

  await db.$transaction([
    db.askMessage.create({
      data: {
        threadId: thread.id,
        role: "assistant",
        content: answer,
        poId: ctx.createdPoIds[0] ?? null,
        raw: ctx.charts?.length ? JSON.stringify({ charts: ctx.charts }) : null,
      },
    }),
    db.askThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } }),
    db.shop.update({ where: { id: shop }, data: { askQuestionsUsed: { increment: 1 } } }),
  ]);
  return { threadId: thread.id, answer, poIds: ctx.createdPoIds, charts: ctx.charts ?? [], proposals: wctx.proposals };
}
