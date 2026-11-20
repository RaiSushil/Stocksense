// Rows-per-page handling shared by every list: ?per=10|20|50|all&page=N, default 20.

export const PAGE_SIZES = ["10", "20", "50", "all"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = "20";

export interface Paging {
  page: number;
  per: PageSize;
  take: number | undefined;
  skip: number;
}

export function paging(url: URL): Paging {
  const raw = url.searchParams.get("per") ?? DEFAULT_PAGE_SIZE;
  const per = (PAGE_SIZES as readonly string[]).includes(raw) ? (raw as PageSize) : DEFAULT_PAGE_SIZE;
  const page = per === "all" ? 1 : Math.max(1, Math.floor(Number(url.searchParams.get("page") ?? 1)) || 1);
  const size = per === "all" ? undefined : Number(per);
  return { page, per, take: size, skip: size ? (page - 1) * size : 0 };
}

export function pageCount(total: number, p: Pick<Paging, "per">) {
  return p.per === "all" ? 1 : Math.max(1, Math.ceil(total / Number(p.per)));
}
