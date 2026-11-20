export function money(value: number, currency = "USD", digits?: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: digits ?? (Math.abs(value) >= 1000 ? 0 : 2),
      minimumFractionDigits: digits ?? (Math.abs(value) >= 1000 ? 0 : 2),
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function num(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

export function coverLabel(days: number): string {
  if (days >= 999) return "no demand";
  if (days >= 365) return "365+ days";
  return `${Math.max(0, Math.floor(days))} days`;
}

export function variantLabel(v: { productTitle: string; variantTitle?: string | null }): string {
  const vt = v.variantTitle && v.variantTitle !== "Default Title" ? ` / ${v.variantTitle}` : "";
  return `${v.productTitle}${vt}`;
}

export function shortId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export const STATUS_LABEL: Record<string, string> = {
  REORDER_NOW: "Reorder now",
  WATCH: "Watch",
  HEALTHY: "Healthy",
  OVERSTOCKED: "Overstocked",
  NO_DATA: "No sales yet",
};

export const STATUS_TONE: Record<string, "critical" | "warning" | "success" | "info" | "neutral"> = {
  REORDER_NOW: "critical",
  WATCH: "warning",
  HEALTHY: "success",
  OVERSTOCKED: "info",
  NO_DATA: "neutral",
};

export const PO_STATUS_TONE: Record<string, "critical" | "warning" | "success" | "info" | "neutral"> = {
  DRAFT: "warning",
  APPROVED: "info",
  SENT: "info",
  PARTIAL: "warning",
  RECEIVED: "success",
  CANCELLED: "neutral",
};

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
}
