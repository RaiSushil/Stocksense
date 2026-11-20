// Plans and feature gates, matching the pricing table.
// Monthly prices are the annual price per month divided by 0.71 (annual saves 29%).

export type PlanId = "NONE" | "LAUNCH" | "SCALE" | "PRO";
export type Interval = "MONTHLY" | "ANNUAL";

export type Feature =
  | "emailAlerts"
  | "csvExport"
  | "slackAlerts"
  | "phoneAlerts"
  | "leadTimeAlerts"
  | "velocityAlerts"
  | "draftPurchaseOrders"
  | "ask"
  | "supplierScorecards"
  | "transfers"
  | "api"
  | "multiLocation";

export interface PlanDef {
  id: Exclude<PlanId, "NONE">;
  name: string;
  tagline: string;
  monthly: number;
  annual: number; // billed once a year
  skuLimit: number; // Infinity for unlimited
  rebuildEveryHours: number; // weekly, nightly or hourly forecast rebuild
  rebuildLabel: string;
  locationLimit: number;
  askQuota: number; // questions per month, Infinity for unlimited
  features: Feature[];
  bullets: string[];
}

export const PLANS: Record<Exclude<PlanId, "NONE">, PlanDef> = {
  LAUNCH: {
    id: "LAUNCH",
    name: "Launch",
    tagline: "For a single store finding its footing.",
    monthly: 15,
    annual: 127.8,
    skuLimit: 500,
    rebuildEveryHours: 24 * 7,
    rebuildLabel: "Weekly",
    locationLimit: 1,
    askQuota: 0,
    features: ["emailAlerts", "csvExport"],
    bullets: ["Up to 500 SKUs forecast", "Weekly forecast rebuild", "1 location", "Low-stock email alerts", "CSV export"],
  },
  SCALE: {
    id: "SCALE",
    name: "Scale",
    tagline: "For stores where a stockout costs real money.",
    monthly: 45,
    annual: 383.76,
    skuLimit: 10_000,
    rebuildEveryHours: 24,
    rebuildLabel: "Nightly",
    locationLimit: Infinity,
    askQuota: 100,
    features: [
      "emailAlerts",
      "csvExport",
      "slackAlerts",
      "phoneAlerts",
      "leadTimeAlerts",
      "velocityAlerts",
      "draftPurchaseOrders",
      "ask",
      "multiLocation",
    ],
    bullets: [
      "Up to 10,000 SKUs forecast",
      "Nightly forecast rebuild",
      "Unlimited locations",
      "Lead-time and velocity alerts",
      "Slack, SMS and WhatsApp alerts",
      "Draft purchase orders",
      "Ask your inventory, 100 questions a month",
    ],
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    tagline: "For multi-location operators and wholesalers.",
    monthly: 120,
    annual: 1023.48,
    skuLimit: Infinity,
    rebuildEveryHours: 1,
    rebuildLabel: "Hourly",
    locationLimit: Infinity,
    askQuota: Infinity,
    features: [
      "emailAlerts",
      "csvExport",
      "slackAlerts",
      "phoneAlerts",
      "leadTimeAlerts",
      "velocityAlerts",
      "draftPurchaseOrders",
      "ask",
      "multiLocation",
      "supplierScorecards",
      "transfers",
      "api",
    ],
    bullets: [
      "Unlimited SKUs forecast",
      "Hourly forecast rebuild",
      "Unlimited locations",
      "Supplier scorecards and transfers",
      "Full REST API and webhooks",
      "Ask your inventory, unlimited",
    ],
  },
};

export const TRIAL_DAYS = 14;

/** Billing plan keys used with Shopify Billing, e.g. "Scale Annual". */
export function billingKey(plan: Exclude<PlanId, "NONE">, interval: Interval): string {
  return `${PLANS[plan].name} ${interval === "ANNUAL" ? "Annual" : "Monthly"}`;
}

export function parseBillingKey(key: string): { plan: Exclude<PlanId, "NONE">; interval: Interval } | null {
  for (const p of Object.values(PLANS)) {
    if (key === `${p.name} Monthly`) return { plan: p.id, interval: "MONTHLY" };
    if (key === `${p.name} Annual`) return { plan: p.id, interval: "ANNUAL" };
  }
  return null;
}

export function planDef(plan: string): PlanDef | null {
  return plan in PLANS ? PLANS[plan as keyof typeof PLANS] : null;
}

export function hasFeature(plan: string, feature: Feature): boolean {
  return planDef(plan)?.features.includes(feature) ?? false;
}

/** Plan that unlocks a feature first, for upgrade prompts. */
export function planFor(feature: Feature): PlanDef {
  return Object.values(PLANS).find((p) => p.features.includes(feature)) ?? PLANS.PRO;
}

export function skuLimit(plan: string): number {
  return planDef(plan)?.skuLimit ?? 0;
}

/** REST API requests allowed per key per minute (Pro). */
export const RATE_LIMIT_PER_MINUTE = 120;
