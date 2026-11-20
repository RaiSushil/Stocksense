// Bulk operations: run a query in the background on Shopify and stream the JSONL result.
// Used for the catalog import and the two-year order history import.

import { gql, type AdminClient, ShopifyGraphQLError } from "./admin.server";

const START = `#graphql
  mutation StockSenseBulk($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

const POLL = `#graphql
  query StockSenseBulkStatus($id: ID!) {
    bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl }
  }`;

export interface BulkProgress {
  (status: string, objectCount: number): void | Promise<void>;
}

export async function runBulkQuery(
  admin: AdminClient,
  query: string,
  onProgress?: BulkProgress,
  timeoutMs = 60 * 60 * 1000,
): Promise<AsyncGenerator<Record<string, any>>> {
  const started = await gql<any>(admin, START, { query });
  const errors = started.bulkOperationRunQuery.userErrors;
  if (errors?.length) throw new ShopifyGraphQLError("Bulk operation rejected", errors);
  const id = started.bulkOperationRunQuery.bulkOperation.id as string;

  const deadline = Date.now() + timeoutMs;
  let delay = 2000;
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15000);
    const data = await gql<any>(admin, POLL, { id });
    const op = data.bulkOperation;
    await onProgress?.(op.status, Number(op.objectCount ?? 0));
    if (op.status === "COMPLETED") {
      return readJsonl(op.url ?? null);
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      throw new ShopifyGraphQLError(`Bulk operation ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`, op.errorCode);
    }
    if (Date.now() > deadline) throw new ShopifyGraphQLError("Bulk operation timed out");
  }
}

async function* readJsonl(url: string | null): AsyncGenerator<Record<string, any>> {
  if (!url) return; // no results
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new ShopifyGraphQLError(`Could not download bulk result (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer.trim());
}
