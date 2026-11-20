import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { ask, AskQuotaError, askQuota } from "../lib/ask/agent.server";
import { hasFeature } from "../lib/plans";

// Data endpoint for the Ask StockSense panel (floating drawer and full page).
// GET  /app/ask-api?thread=ID   conversations list + messages of one conversation
// POST /app/ask-api             intent=send|rename|delete

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const threadId = new URL(request.url).searchParams.get("thread");
  const threads = await db.askThread.findMany({
    where: { shop: shop.id },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { _count: { select: { messages: true } } },
  });
  const thread = threadId ? threads.find((t) => t.id === threadId) ?? null : null;
  const messages = thread ? await db.askMessage.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } }) : [];
  const pos = new Map(
    (await db.purchaseOrder.findMany({ where: { id: { in: messages.map((m) => m.poId).filter((x): x is string => !!x) } } })).map((p) => [p.id, p]),
  );
  const quota = askQuota(shop.plan);
  return {
    allowed: hasFeature(shop.plan, "ask"),
    configured: !!process.env.ANTHROPIC_API_KEY,
    quota: Number.isFinite(quota) ? quota : null,
    used: shop.askQuestionsUsed,
    threadId: thread?.id ?? null,
    threads: threads.map((t) => ({ id: t.id, title: t.title ?? "Conversation", updatedAt: t.updatedAt.toISOString(), count: t._count.messages })),
    messages: messages.map((m) => {
      const raw = m.raw ? safeJson(m.raw) : null;
      const po = m.poId ? pos.get(m.poId) : undefined;
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        charts: (raw?.charts ?? []) as unknown[],
        po: po ? { id: po.id, number: po.number, status: po.status } : null,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "send");
  const threadId = String(form.get("threadId") ?? "") || undefined;

  if (intent === "rename" && threadId) {
    const title = String(form.get("title") ?? "").trim().slice(0, 80);
    if (title) await db.askThread.updateMany({ where: { id: threadId, shop: shop.id }, data: { title } });
    return { ok: true, threadId };
  }
  if (intent === "delete" && threadId) {
    await db.askThread.deleteMany({ where: { id: threadId, shop: shop.id } });
    return { ok: true, threadId: null, deleted: threadId };
  }

  const question = String(form.get("question") ?? "").trim();
  if (!question) return { error: "Type a question first.", threadId };
  try {
    const res = await ask(shop.id, question, threadId);
    return { ok: true, threadId: res.threadId };
  } catch (err) {
    if (err instanceof AskQuotaError) return { error: err.message, threadId };
    console.error("[stocksense] ask failed", err);
    return { error: err instanceof Error ? err.message : "Could not answer that right now.", threadId };
  }
};

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
