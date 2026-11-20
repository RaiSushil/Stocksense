// StockSense UI kit. Plain elements styled by app/styles/stocksense.css so the
// Dark, Light and Default themes apply everywhere.

import { useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { shortId, STATUS_LABEL, STATUS_TONE } from "../lib/format";
import { planFor, type Feature } from "../lib/plans";
import {
  appearanceSnapshot,
  saveAppearance,
  serverAppearanceSnapshot,
  subscribeAppearance,
  type Accent,
  type Density,
  type Theme,
} from "../lib/appearance";

export type Tone = "critical" | "warning" | "success" | "info" | "neutral" | "accent";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------- Page ---------- */

export function Page({
  title,
  accent,
  eyebrow,
  subtitle,
  actions,
  back,
  intro,
  aside,
  children,
}: {
  title: string;
  accent?: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  /** Extra content under the subtitle in hero layout. */
  intro?: ReactNode;
  /** When set, the header becomes a two-column hero with this on the right. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  if (aside) {
    return (
      <div className="ss-shell">
        <ui-title-bar title={accent ? `${title} ${accent}` : title} />
        <div className="ss-container">
          <div className="ss-toolbar">
            <div className="ss-eyebrow">{eyebrow}</div>
            <div className="ss-header-actions">
              {actions}
              <ThemeToggle />
            </div>
          </div>
          <div className="ss-hero">
            <div className="ss-header-main">
              <h1 className="ss-title" style={{ fontSize: "clamp(30px, 3.6vw, 46px)" }}>
                {title}
                {accent && (
                  <>
                    <br />
                    <em>{accent}</em>
                  </>
                )}
              </h1>
              {subtitle && <p className="ss-subtitle" style={{ fontSize: 15.5, marginTop: 10 }}>{subtitle}</p>}
              {intro}
            </div>
            {aside}
          </div>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="ss-shell">
      <ui-title-bar title={accent ? `${title} ${accent}` : title} />
      <div className="ss-container">
        <header className="ss-header">
          <div className="ss-header-main">
            {back && (
              <Link className="ss-back" to={back.href}>
                ← {back.label}
              </Link>
            )}
            {eyebrow && <div className="ss-eyebrow">{eyebrow}</div>}
            <h1 className="ss-title">
              {title}
              {accent && (
                <>
                  {" "}
                  <em>{accent}</em>
                </>
              )}
            </h1>
            {subtitle && <p className="ss-subtitle">{subtitle}</p>}
          </div>
          <div className="ss-header-actions">
            {actions}
            <ThemeToggle />
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

const THEME_OPTIONS: { id: Theme; label: string; icon: ReactNode }[] = [
  {
    id: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    ),
  },
  {
    id: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    id: "default",
    label: "Default",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <path d="M8 21h8M12 18v3" />
      </svg>
    ),
  },
];

export function useAppearance() {
  const snap = useSyncExternalStore(subscribeAppearance, appearanceSnapshot, serverAppearanceSnapshot);
  const [theme, accent, density] = snap.split("|") as [Theme, Accent, Density];
  return { theme, accent, density };
}

export function ThemeToggle() {
  const { theme } = useAppearance();
  return (
    <div className="ss-toggle" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((o) => (
        <button key={o.id} type="button" aria-pressed={theme === o.id} onClick={() => saveAppearance({ theme: o.id })} title={`${o.label} theme`}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Layout ---------- */

export function Stack({ children, tight, style }: { children: ReactNode; tight?: boolean; style?: CSSProperties }) {
  return (
    <div className={cx("ss-stack", tight && "tight")} style={style}>
      {children}
    </div>
  );
}

export function Row({
  children,
  between,
  end,
  top,
  nowrap,
  gap,
  style,
}: {
  children: ReactNode;
  between?: boolean;
  end?: boolean;
  top?: boolean;
  nowrap?: boolean;
  gap?: number;
  style?: CSSProperties;
}) {
  return (
    <div className={cx("ss-row", between && "between", end && "end", top && "top", nowrap && "nowrap")} style={{ ...(gap !== undefined ? { gap } : {}), ...style }}>
      {children}
    </div>
  );
}

export function Grid({ children, min = 280 }: { children: ReactNode; min?: number }) {
  return (
    <div className="ss-grid" style={{ "--ss-min": `${min}px` } as CSSProperties}>
      {children}
    </div>
  );
}

export function Split({ children }: { children: ReactNode }) {
  return <div className="ss-split">{children}</div>;
}

/* ---------- Card ---------- */

export function Card({
  title,
  subtitle,
  meta,
  actions,
  flush,
  plainHead,
  footer,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  plainHead?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("ss-card", className)}>
      {(title || actions || meta) && (
        <div className={cx("ss-card-head", plainHead && "plain")}>
          <div>
            {title && (
              <h2 className="ss-card-title">
                <span className="ss-dot" />
                {title}
              </h2>
            )}
            {subtitle && <div className="ss-card-sub">{subtitle}</div>}
          </div>
          <Row>
            {meta && <span className="ss-card-meta">{meta}</span>}
            {actions}
          </Row>
        </div>
      )}
      {children !== undefined && <div className={cx("ss-card-body", flush && "flush")}>{children}</div>}
      {footer && <div className="ss-card-foot">{footer}</div>}
    </section>
  );
}

/* ---------- KPIs ---------- */

export function KpiStrip({ children }: { children: ReactNode }) {
  return <div className="ss-kpis">{children}</div>;
}

export function Kpi({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="ss-kpi">
      <span className="ss-kpi-label">{label}</span>
      <span className="ss-kpi-value">{value}</span>
      {note !== undefined && note !== null && <Badge tone={tone ?? "neutral"}>{note}</Badge>}
    </div>
  );
}

/* ---------- Badges ---------- */

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("ss-badge", tone)}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{(STATUS_LABEL[status] ?? status).toLowerCase()}</Badge>;
}

/**
 * Location filter. On plans with per-location forecasts every active location is
 * listed; otherwise only the store total is shown, with a note about the plan.
 */
export function LocationPills({
  base,
  multi,
  value,
  locations,
  extra,
}: {
  base: string;
  multi: boolean;
  value: string;
  locations: { value: string; label: string }[];
  extra?: Record<string, string>;
}) {
  if (!multi) {
    return (
      <Row>
        <Pills base={base} param="location" value="" options={[{ value: "", label: "All locations" }]} />
        <span className="ss-muted ss-small">
          Forecasts per location are on the Scale and Pro plans. <Link to="/app/billing">See plans</Link>
        </span>
      </Row>
    );
  }
  return <Pills base={base} param="location" value={value} options={[{ value: "", label: "All locations" }, ...locations]} extra={extra} />;
}

/** Status badge that opens the reorder screen when the product needs (or will soon need) stock. */
export function StatusAction({ status, variantId }: { status: string; variantId: string }) {
  if (status !== "REORDER_NOW" && status !== "WATCH") return <StatusBadge status={status} />;
  return (
    <Link to={`/app/reorder/${shortId(variantId)}`} className="ss-reorder-link" title="Open reorder settings and create a purchase order">
      <Badge tone={STATUS_TONE[status] ?? "neutral"}>
        {(STATUS_LABEL[status] ?? status).toLowerCase()} <span aria-hidden="true">→</span>
      </Badge>
    </Link>
  );
}

/* ---------- Buttons ---------- */

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

export function Btn({
  children,
  href,
  variant = "secondary",
  small,
  block,
  loading,
  disabled,
  type = "button",
  onClick,
  title,
}: {
  children: ReactNode;
  href?: string;
  variant?: BtnVariant;
  small?: boolean;
  block?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
  title?: string;
}) {
  const className = cx("ss-btn", variant !== "secondary" && variant, small && "small", block && "block", loading && "loading");
  if (href) {
    if (/^(https?:|mailto:)/.test(href)) {
      return (
        <a className={className} href={href} target="_blank" rel="noreferrer" aria-disabled={disabled} title={title}>
          {children}
        </a>
      );
    }
    return (
      <Link className={className} to={href} aria-disabled={disabled} title={title}>
        {children}
      </Link>
    );
  }
  return (
    <button className={className} type={type} disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

/* ---------- Pills ---------- */

export function Pills({
  options,
  value,
  param,
  base,
  extra = {},
}: {
  options: { value: string; label: string; count?: number }[];
  value: string;
  param: string;
  base: string;
  extra?: Record<string, string>;
}) {
  return (
    <nav className="ss-pills">
      {options.map((o) => {
        const qs = new URLSearchParams({ ...extra, [param]: o.value });
        if (!o.value) qs.delete(param);
        const href = `${base}${qs.toString() ? `?${qs}` : ""}`;
        return (
          <Link key={o.value || "all"} to={href} className={cx("ss-pill", o.value === value && "active")}>
            {o.label}
            {o.count !== undefined && <span className="count">{o.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/* ---------- Banners and states ---------- */

export function Banner({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx("ss-banner", tone)} role={tone === "critical" ? "alert" : "status"}>
      <div>
        {title && <div className="ss-banner-title">{title}</div>}
        {children && <div className="ss-banner-body">{children}</div>}
      </div>
    </div>
  );
}

export function Result({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const d = data as { ok?: string; error?: string };
  if (d.ok) return <Banner tone="success" title={d.ok} />;
  if (d.error) return <Banner tone="critical" title={d.error} />;
  return null;
}

export function Empty({ heading, children }: { heading: string; children?: ReactNode }) {
  return (
    <div className="ss-empty">
      <div className="ss-empty-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 7l9-4 9 4-9 4-9-4z" />
          <path d="M3 7v10l9 4 9-4V7" />
        </svg>
      </div>
      <h3>{heading}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Spinner() {
  return <span className="ss-spinner" aria-label="Loading" />;
}

export function UpgradeNotice({ feature, children }: { feature: Feature; children?: ReactNode }) {
  const plan = planFor(feature);
  return (
    <Card>
      <div className="ss-empty">
        <div className="ss-empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z" />
          </svg>
        </div>
        <h3>
          Available on {plan.name}
          {plan.id === "SCALE" ? " and Pro" : ""}
        </h3>
        <p>{children ?? "Upgrade your plan to use this feature."}</p>
        <div style={{ marginTop: 8 }}>
          <Btn href="/app/billing" variant="primary">
            See plans
          </Btn>
        </div>
      </div>
    </Card>
  );
}

export function SyncBanner({ status, stage, error }: { status: string; stage: string | null; error: string | null }) {
  const revalidator = useRevalidator();
  const retry = useFetcher();
  // While the import runs, refresh the page data every few seconds so progress
  // and the first forecasts appear without a manual reload.
  useEffect(() => {
    if (status === "READY" || status === "ERROR") return;
    const t = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => window.clearInterval(t);
  }, [status, revalidator]);
  if (status === "READY") return null;
  if (status === "ERROR") {
    return (
      <Banner tone="critical" title="The last import did not finish">
        <Stack tight>
          <span>{(error ?? "Unknown error").replace(/\.?$/, ".")} StockSense retries on its own every hour.</span>
          <retry.Form method="post" action="/app/settings?section=data">
            <input type="hidden" name="intent" value="reimport" />
            <Btn type="submit" small loading={retry.state !== "idle"}>
              Retry import now
            </Btn>
          </retry.Form>
        </Stack>
      </Banner>
    );
  }
  return (
    <Banner tone="info" title="Connecting your store">
      <Row>
        <Spinner />
        <span>
          {stage ?? "Starting the import"}. Products and stock arrive in a few minutes; order history keeps importing in the background.
          This page updates by itself.
        </span>
      </Row>
    </Banner>
  );
}

/* ---------- Forms ---------- */

export function Field({ label, help, children, htmlFor }: { label: string; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="ss-field">
      <label className="ss-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <span className="ss-help">{help}</span>}
    </div>
  );
}

export function FormGrid({ children, min = 220 }: { children: ReactNode; min?: number }) {
  return (
    <div className="ss-form-grid" style={{ "--ss-min": `${min}px` } as CSSProperties}>
      {children}
    </div>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { label?: string; help?: ReactNode };

export function Input({ label, help, className, id, ...rest }: InputProps) {
  const inputId = id ?? (rest.name ? `f-${rest.name}` : undefined);
  const input = <input id={inputId} className={cx("ss-input", className)} {...rest} />;
  if (!label) return input;
  return (
    <Field label={label} help={help} htmlFor={inputId}>
      {input}
    </Field>
  );
}

export function Select({
  label,
  help,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string; help?: ReactNode }) {
  const id = rest.id ?? (rest.name ? `f-${rest.name}` : undefined);
  const el = (
    <select id={id} className="ss-select" {...rest}>
      {children}
    </select>
  );
  if (!label) return el;
  return (
    <Field label={label} help={help} htmlFor={id}>
      {el}
    </Field>
  );
}

export function TextArea({ label, help, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; help?: ReactNode }) {
  const id = rest.id ?? (rest.name ? `f-${rest.name}` : undefined);
  const el = <textarea id={id} className="ss-textarea" {...rest} />;
  if (!label) return el;
  return (
    <Field label={label} help={help} htmlFor={id}>
      {el}
    </Field>
  );
}

export function Check({ label, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="ss-check">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

/* ---------- Key/value list ---------- */

export function List({ children }: { children: ReactNode }) {
  return <div className="ss-list">{children}</div>;
}

export function ListRow({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="ss-list-row">
      <div style={{ minWidth: 0 }}>{left}</div>
      <div>{right}</div>
    </div>
  );
}
