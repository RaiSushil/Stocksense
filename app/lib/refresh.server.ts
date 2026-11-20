// Near-real-time refresh. Orders and stock changes arrive by webhook in bursts
// (an order is followed by an inventory update a moment later), so changes are
// collected per shop for a few seconds and then refreshed together.

import { inBackground, runPartialRefresh } from "./jobs.server";

const DEBOUNCE_MS = 15_000;
const RETRY_MS = 60_000;

const pending = new Map<string, { ids: Set<string>; timer: ReturnType<typeof setTimeout> | null }>();

export function queueRefresh(shop: string, variantIds: string[], delay = DEBOUNCE_MS) {
  if (!variantIds.length) return;
  const entry = pending.get(shop) ?? { ids: new Set<string>(), timer: null };
  variantIds.forEach((id) => entry.ids.add(id));
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => inBackground("refresh", flush(shop)), delay);
  pending.set(shop, entry);
}

async function flush(shop: string) {
  const entry = pending.get(shop);
  if (!entry) return;
  pending.delete(shop);
  const ids = [...entry.ids];
  const done = await runPartialRefresh(shop, ids);
  if (done) {
    console.info(`[stocksense] ${shop}: refreshed ${ids.length} forecast${ids.length === 1 ? "" : "s"} after store changes`);
  } else {
    // An import or scheduled rebuild is running; try again shortly.
    queueRefresh(shop, ids, RETRY_MS);
  }
}
