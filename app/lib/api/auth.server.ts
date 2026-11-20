// REST API authentication (Pro). Keys look like ss_live_xxx or ss_test_xxx (sandbox).
// Only a SHA-256 hash is stored. Sandbox keys can read everything but writes are
// validated and echoed back without being saved.

import crypto from "node:crypto";
import db from "../../db.server";
import { hasFeature, RATE_LIMIT_PER_MINUTE } from "../plans";

export { RATE_LIMIT_PER_MINUTE };


export function hashKey(key: string) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export async function createApiKey(shop: string, name: string, sandbox: boolean) {
  const secret = crypto.randomBytes(24).toString("base64url");
  const key = `ss_${sandbox ? "test" : "live"}_${secret}`;
  await db.apiKey.create({ data: { shop, name, sandbox, prefix: key.slice(0, 12), hash: hashKey(key) } });
  return key; // shown once
}

export interface ApiContext {
  shop: string;
  sandbox: boolean;
  keyId: string;
  rateHeaders: Record<string, string>;
}

const buckets = new Map<string, { tokens: number; updated: number }>();

function rateLimit(keyId: string) {
  const now = Date.now();
  const b = buckets.get(keyId) ?? { tokens: RATE_LIMIT_PER_MINUTE, updated: now };
  b.tokens = Math.min(RATE_LIMIT_PER_MINUTE, b.tokens + ((now - b.updated) / 60_000) * RATE_LIMIT_PER_MINUTE);
  b.updated = now;
  const allowed = b.tokens >= 1;
  if (allowed) b.tokens -= 1;
  buckets.set(keyId, b);
  return {
    allowed,
    headers: {
      "X-RateLimit-Limit": String(RATE_LIMIT_PER_MINUTE),
      "X-RateLimit-Remaining": String(Math.floor(b.tokens)),
      ...(allowed ? {} : { "Retry-After": String(Math.ceil((1 - b.tokens) * (60 / RATE_LIMIT_PER_MINUTE))) }),
    },
  };
}

export function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  return Response.json({ error: { status, message } }, { status, headers });
}

/** Authenticate a REST request. Throws a Response on failure. */
export async function authenticateApi(request: Request): Promise<ApiContext> {
  const header = request.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : request.headers.get("x-api-key") ?? "";
  if (!key) throw apiError(401, "Missing API key. Send Authorization: Bearer <key>.");
  const row = await db.apiKey.findUnique({ where: { hash: hashKey(key) } });
  if (!row || row.revokedAt) throw apiError(401, "Invalid or revoked API key.");
  const shop = await db.shop.findUnique({ where: { id: row.shop } });
  if (!shop || shop.uninstalledAt) throw apiError(403, "The store for this key is not active.");
  if (!hasFeature(shop.plan, "api")) throw apiError(403, "The REST API is available on the Pro plan.");
  const rl = rateLimit(row.id);
  if (!rl.allowed) throw apiError(429, "Rate limit exceeded.", rl.headers);
  // Avoid a write per request: only touch lastUsedAt once a minute.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  }
  return { shop: row.shop, sandbox: row.sandbox, keyId: row.id, rateHeaders: rl.headers };
}

export function apiJson(ctx: ApiContext, data: unknown, status = 200) {
  return Response.json(data, { status, headers: { ...ctx.rateHeaders, ...(ctx.sandbox ? { "X-StockSense-Sandbox": "true" } : {}) } });
}

/** Accepts a numeric id or a full gid. */
export function variantGid(id: string) {
  return id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`;
}
