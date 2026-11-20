import { unauthenticated } from "../../shopify.server";

/** The subset of the Admin API client we use. Works for both authenticated and offline clients. */
export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export class ShopifyGraphQLError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
  }
}

export async function gql<T = any>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    const first = Array.isArray(json.errors) ? (json.errors[0] as { message?: string })?.message : undefined;
    throw new ShopifyGraphQLError(first ? `Shopify GraphQL error: ${first}` : "Shopify GraphQL error", json.errors);
  }
  return json.data as T;
}

/**
 * Offline Admin client for background jobs (scheduler, webhooks, API).
 * The session is loaded on every call so long jobs (bulk imports can run for a
 * while) always use a fresh, refreshed offline token.
 */
export async function offlineAdmin(shop: string): Promise<AdminClient> {
  await unauthenticated.admin(shop); // fail fast if the shop has no offline session
  return {
    graphql: async (query, options) => {
      const { admin } = await unauthenticated.admin(shop);
      return (admin as unknown as AdminClient).graphql(query, options);
    },
  };
}
