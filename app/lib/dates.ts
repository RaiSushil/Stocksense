// Date helpers. All forecasting works on calendar days expressed as YYYY-MM-DD strings
// in the shop's timezone, so a sale at 23:30 local time lands on the right day.

const DAY_MS = 86_400_000;

export function dayInTimezone(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function todayIn(timeZone: string): string {
  return dayInTimezone(new Date(), timeZone);
}

/** Parse YYYY-MM-DD as a UTC midnight timestamp (day arithmetic only). */
export function parseDay(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * DAY_MS);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(a) - parseDay(b)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(day: string): number {
  return new Date(parseDay(day)).getUTCDay();
}

/** 0 = January ... 11 = December */
export function monthOf(day: string): number {
  return new Date(parseDay(day)).getUTCMonth();
}

export function dayRange(start: string, endInclusive: string): string[] {
  const out: string[] = [];
  const n = diffDays(endInclusive, start);
  for (let i = 0; i <= n; i++) out.push(addDays(start, i));
  return out;
}

export function weekdayName(day: string): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday(day)];
}

export function timeAgo(date: Date | string, now: Date = new Date()): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

export function shortDate(day: string): string {
  const d = new Date(parseDay(day));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
