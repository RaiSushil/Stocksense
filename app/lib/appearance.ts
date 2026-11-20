// Appearance settings (theme, accent colour, density). Stored per browser in
// localStorage and applied as data attributes on <html> before first paint.

export type Theme = "dark" | "light" | "default";
export type Accent = "orange" | "teal" | "indigo" | "green" | "rose";
export type Density = "comfortable" | "compact";

export interface Appearance {
  theme: Theme;
  accent: Accent;
  density: Density;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "dark", accent: "orange", density: "comfortable" };
export const STORAGE_KEY = "stocksense-appearance";

export const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: "orange", label: "Ember", color: "#f26b1d" },
  { id: "teal", label: "Lagoon", color: "#14a394" },
  { id: "indigo", label: "Dusk", color: "#5b5bd6" },
  { id: "green", label: "Sage", color: "#2f9e5b" },
  { id: "rose", label: "Rose", color: "#e0456b" },
];

/** Inline script for <head>: applies the saved appearance before the page renders. */
export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var d=${JSON.stringify(DEFAULT_APPEARANCE)};var s=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"{}");var a=Object.assign({},d,s);var h=document.documentElement;h.dataset.theme=a.theme;h.dataset.accent=a.accent;h.dataset.density=a.density;}catch(e){}})();`;

// Last applied value, used when storage is blocked inside the admin iframe.
let memory: Appearance | null = null;

export function readAppearance(): Appearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_APPEARANCE, ...JSON.parse(stored) };
  } catch {
    // fall through to memory
  }
  return memory ?? DEFAULT_APPEARANCE;
}

/** For useSyncExternalStore: a stable string snapshot of the current appearance. */
export function appearanceSnapshot(): string {
  const a = readAppearance();
  return `${a.theme}|${a.accent}|${a.density}`;
}

export function serverAppearanceSnapshot(): string {
  const a = DEFAULT_APPEARANCE;
  return `${a.theme}|${a.accent}|${a.density}`;
}

export function subscribeAppearance(cb: () => void) {
  window.addEventListener("stocksense:appearance", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("stocksense:appearance", cb);
    window.removeEventListener("storage", cb);
  };
}

export function saveAppearance(next: Partial<Appearance>): Appearance {
  const merged = { ...readAppearance(), ...next };
  memory = merged;
  const h = document.documentElement;
  h.dataset.theme = merged.theme;
  h.dataset.accent = merged.accent;
  h.dataset.density = merged.density;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage can be blocked inside some iframes; the change still applies for this visit.
  }
  window.dispatchEvent(new CustomEvent("stocksense:appearance", { detail: merged }));
  return merged;
}
