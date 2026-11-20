import { Link, useLocation } from "react-router";
import { PAGE_SIZES, type PageSize } from "../lib/paging";

/** Rows per page (10, 20, 50, All) plus previous/next, driven by the URL. */
export function Pager({ total, page, per }: { total: number; page: number; per: PageSize }) {
  const { pathname, search } = useLocation();
  const href = (changes: Record<string, string>) => {
    const qs = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) qs.set(k, v);
    return `${pathname}?${qs}`;
  };
  const size = per === "all" ? total : Number(per);
  const pages = per === "all" ? 1 : Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);

  return (
    <div className="ss-pager">
      <div className="ss-pager-sizes">
        <span className="ss-muted ss-small">Rows per page</span>
        <nav className="ss-pills">
          {PAGE_SIZES.map((s) => (
            <Link key={s} to={href({ per: s, page: "1" })} preventScrollReset className={`ss-pill${s === per ? " active" : ""}`}>
              {s === "all" ? "All" : s}
            </Link>
          ))}
        </nav>
      </div>
      <div className="ss-pager-nav">
        <span className="ss-card-meta">
          {from}–{to} of {total}
        </span>
        {page > 1 ? (
          <Link className="ss-btn small" to={href({ page: String(page - 1) })} preventScrollReset>
            ‹ Previous
          </Link>
        ) : (
          <span className="ss-btn small" aria-disabled="true">
            ‹ Previous
          </span>
        )}
        {page < pages ? (
          <Link className="ss-btn small" to={href({ page: String(page + 1) })} preventScrollReset>
            Next ›
          </Link>
        ) : (
          <span className="ss-btn small" aria-disabled="true">
            Next ›
          </span>
        )}
      </div>
    </div>
  );
}
