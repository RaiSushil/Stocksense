import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { ReactNode } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import crypto from "node:crypto";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { hasFeature, planDef, RATE_LIMIT_PER_MINUTE } from "../lib/plans";
import { createApiKey } from "../lib/api/auth.server";
import { inBackground, runFullSync, runRebuild } from "../lib/jobs.server";
import { normalisePhone, phoneChannels, sendEmail, sendSlack, sendSms } from "../lib/notify.server";
import { businessNumber, sendWhatsappAlert, whatsappProvider } from "../lib/whatsapp/provider.server";
import { createLinkCode } from "../lib/whatsapp/inbox.server";
import { timeAgo } from "../lib/dates";
import { clearDemo, seedDemo } from "../lib/demo.server";
import { ACCENTS, saveAppearance, type Density, type Theme } from "../lib/appearance";
import { Badge, Banner, Btn, Card, Check, FormGrid, Input, List, ListRow, Page, Row, Select, Stack, useAppearance } from "../components/ui";

// Demo data would mix fake products into a real store's numbers, so in production it
// is only offered on Shopify development stores (or when explicitly allowed for staging).
const demoAllowed = (shop: { isDevStore: boolean }) =>
  shop.isDevStore || process.env.NODE_ENV !== "production" || process.env.STOCKSENSE_ALLOW_DEMO === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const [waLinks, waActions] = await Promise.all([
    db.whatsappLink.findMany({ where: { shop: shop.id }, orderBy: { createdAt: "asc" } }),
    db.pendingAction.findMany({ where: { shop: shop.id }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  const [promotions, keys, hooks, vendors, types, variantCount, locationCount, threadCount] = await Promise.all([
    db.promotion.findMany({ where: { shop: shop.id }, orderBy: { startDate: "asc" } }),
    db.apiKey.findMany({ where: { shop: shop.id, revokedAt: null }, orderBy: { createdAt: "desc" } }),
    db.webhookEndpoint.findMany({ where: { shop: shop.id }, orderBy: { createdAt: "desc" } }),
    db.variant.findMany({ where: { shop: shop.id, vendor: { not: null } }, distinct: ["vendor"], select: { vendor: true } }),
    db.variant.findMany({ where: { shop: shop.id, productType: { not: null } }, distinct: ["productType"], select: { productType: true } }),
    db.variant.count({ where: { shop: shop.id } }),
    db.location.count({ where: { shop: shop.id, isActive: true } }),
    db.askThread.count({ where: { shop: shop.id } }),
  ]);
  const plan = planDef(shop.plan);
  return {
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    demoAllowed: demoAllowed(shop),
    store: {
      domain: shop.id,
      name: shop.name ?? shop.id.replace(".myshopify.com", ""),
      email: shop.email ?? "",
      currency: shop.currency,
      timezone: shop.timezone,
      installedAt: shop.installedAt.toISOString(),
      plan: plan?.name ?? "No plan",
      interval: shop.billingInterval,
      skuLimit: plan ? (Number.isFinite(plan.skuLimit) ? plan.skuLimit : null) : 0,
      rebuild: plan?.rebuildLabel ?? "",
      locationLimit: plan ? (Number.isFinite(plan.locationLimit) ? plan.locationLimit : null) : 0,
      variants: variantCount,
      locations: locationCount,
    },
    ask: {
      configured: !!process.env.ANTHROPIC_API_KEY,
      quota: plan ? (Number.isFinite(plan.askQuota) ? plan.askQuota : null) : 0,
      used: shop.askQuestionsUsed,
      periodStart: shop.askPeriodStart.toISOString(),
      threads: threadCount,
    },
    shop: {
      serviceLevel: shop.serviceLevel,
      coverageDays: shop.coverageDays,
      overstockDays: shop.overstockDays,
      defaultLeadTimeDays: shop.defaultLeadTimeDays,
      velocityThreshold: shop.velocityThreshold,
      alertEmail: shop.alertEmail ?? "",
      notifyEmail: shop.notifyEmail,
      slackWebhookUrl: shop.slackWebhookUrl ?? "",
      notifySlack: shop.notifySlack,
      alertPhone: shop.alertPhone ?? "",
      notifySms: shop.notifySms,
      notifyWhatsapp: shop.notifyWhatsapp,
      phoneUrgentOnly: shop.phoneUrgentOnly,
      syncStatus: shop.syncStatus,
      syncStage: shop.syncStage,
      lastFullSyncAt: shop.lastFullSyncAt?.toISOString() ?? null,
      lastForecastAt: shop.lastForecastAt?.toISOString() ?? null,
    },
    features: {
      slack: hasFeature(shop.plan, "slackAlerts"),
      phone: hasFeature(shop.plan, "phoneAlerts"),
      api: hasFeature(shop.plan, "api"),
    },
    phoneReady: phoneChannels(),
    whatsapp: {
      allowed: hasFeature(shop.plan, "phoneAlerts"),
      provider: whatsappProvider(),
      number: businessNumber(),
      ai: !!process.env.ANTHROPIC_API_KEY,
      links: waLinks.map((l) => ({ id: l.id, phone: l.phone, canApprove: l.canApprove, createdAt: l.createdAt.toISOString(), lastInboundAt: l.lastInboundAt?.toISOString() ?? null })),
      actions: waActions.map((a) => ({ id: a.id, type: a.type, summary: a.summary.replace(/\*/g, ""), status: a.status, source: a.source, phone: a.phone, createdAt: a.createdAt.toISOString(), result: a.result })),
    },
    promotions: promotions.map((p) => ({ id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, upliftPct: p.upliftPct, scope: p.scope, scopeValue: p.scopeValue })),
    keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, sandbox: k.sandbox, lastUsedAt: k.lastUsedAt?.toISOString() ?? null })),
    hooks: hooks.map((h) => ({ id: h.id, url: h.url, events: h.events, active: h.active, lastStatus: h.lastStatus, secret: h.secret })),
    vendors: vendors.map((v) => v.vendor!).sort(),
    productTypes: types.map((t) => t.productType!).sort(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const num = (k: string, lo: number, hi: number, dflt: number) => {
    const n = Number(form.get(k));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };

  switch (intent) {
    case "forecasting": {
      await db.shop.update({
        where: { id: shop.id },
        data: {
          serviceLevel: num("serviceLevel", 50, 99.9, 95) / 100,
          coverageDays: Math.round(num("coverageDays", 7, 365, 60)),
          overstockDays: Math.round(num("overstockDays", 30, 730, 90)),
          defaultLeadTimeDays: Math.round(num("defaultLeadTimeDays", 1, 180, 14)),
          velocityThreshold: num("velocityThreshold", 1.2, 10, 1.8),
        },
      });
      inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
      return { ok: "Saved. Forecasts are being rebuilt with the new settings." };
    }
    case "notifications": {
      const phoneRaw = String(form.get("alertPhone") ?? "").trim();
      const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
      if (phoneRaw && !phone) return { error: "Enter the mobile number with its country code, for example +91 98765 43210." };
      const notifySms = form.get("notifySms") === "on";
      const notifyWhatsapp = form.get("notifyWhatsapp") === "on";
      if ((notifySms || notifyWhatsapp) && !phone) return { error: "Add a mobile number to get text or WhatsApp alerts." };
      await db.shop.update({
        where: { id: shop.id },
        data: {
          alertEmail: String(form.get("alertEmail") ?? "").trim() || null,
          notifyEmail: form.get("notifyEmail") === "on",
          slackWebhookUrl: String(form.get("slackWebhookUrl") ?? "").trim() || null,
          notifySlack: form.get("notifySlack") === "on",
          // Phone fields are only on the form for plans that include them.
          ...(form.has("alertPhone")
            ? { alertPhone: phone, notifySms, notifyWhatsapp, phoneUrgentOnly: form.get("phoneUrgentOnly") === "on" }
            : {}),
        },
      });
      return { ok: "Notification settings saved." };
    }
    case "test-notify": {
      const row = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
      const sent: string[] = [];
      if (row.alertEmail && (await sendEmail({ to: row.alertEmail, subject: "StockSense test alert", text: "Alerts will arrive here.", html: "<p>Alerts will arrive here.</p>" }))) sent.push("email");
      if (row.slackWebhookUrl && hasFeature(shop.plan, "slackAlerts") && (await sendSlack(row.slackWebhookUrl, "StockSense test alert", ["Alerts will arrive in this channel."]))) sent.push("Slack");
      const failed: string[] = [];
      if (row.alertPhone && hasFeature(shop.plan, "phoneAlerts")) {
        const text = "StockSense test alert. Stock alerts for your store will arrive here.";
        if (row.notifySms) {
          const r = await sendSms(row.alertPhone, text);
          if (r.ok) sent.push("SMS");
          else failed.push(`SMS: ${r.error}`);
        }
        if (row.notifyWhatsapp) {
          const r = await sendWhatsappAlert(row.alertPhone, text, shop.id);
          if (r.ok) sent.push("WhatsApp");
          else failed.push(`WhatsApp: ${r.error}`);
        }
      }
      const list = sent.length > 1 ? `${sent.slice(0, -1).join(", ")} and ${sent[sent.length - 1]}` : sent[0];
      if (failed.length) return { error: `${sent.length ? `Sent by ${list}, but ` : ""}${failed.join("; ")}.` };
      return sent.length ? { ok: `Test sent by ${list}.` } : { error: "Nothing was sent. Check the email address, Slack URL, mobile number, or the server's SMTP_URL." };
    }
    case "add-promo": {
      const startDate = String(form.get("startDate") ?? "");
      const endDate = String(form.get("endDate") ?? "") || startDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || endDate < startDate) return { error: "Choose a valid date range." };
      const scope = String(form.get("scope") ?? "ALL");
      await db.promotion.create({
        data: {
          shop: shop.id,
          name: String(form.get("name") ?? "").trim() || "Promotion",
          startDate,
          endDate,
          upliftPct: num("upliftPct", 1, 1000, 30),
          scope,
          scopeValue: scope === "ALL" ? null : String(form.get(scope === "VENDOR" ? "vendor" : "productType") ?? ""),
        },
      });
      inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
      return { ok: "Promotion added. Forecasts for those days now include the uplift." };
    }
    case "delete-promo": {
      await db.promotion.deleteMany({ where: { id: String(form.get("id")), shop: shop.id } });
      inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
      return { ok: "Promotion removed." };
    }
    case "create-key": {
      if (!hasFeature(shop.plan, "api")) return { error: "The REST API is on the Pro plan." };
      const key = await createApiKey(shop.id, String(form.get("name") ?? "").trim() || "API key", form.get("sandbox") === "on");
      return { ok: "Key created. Copy it now; it will not be shown again.", key };
    }
    case "revoke-key": {
      await db.apiKey.updateMany({ where: { id: String(form.get("id")), shop: shop.id }, data: { revokedAt: new Date() } });
      return { ok: "Key revoked." };
    }
    case "add-hook": {
      if (!hasFeature(shop.plan, "api")) return { error: "Webhooks are on the Pro plan." };
      const url = String(form.get("url") ?? "").trim();
      if (!/^https:\/\//.test(url)) return { error: "Webhook URLs must use https." };
      await db.webhookEndpoint.create({
        data: { shop: shop.id, url, secret: crypto.randomBytes(24).toString("hex"), events: String(form.get("events") ?? "*").trim() || "*" },
      });
      return { ok: "Webhook added." };
    }
    case "delete-hook": {
      await db.webhookEndpoint.deleteMany({ where: { id: String(form.get("id")), shop: shop.id } });
      return { ok: "Webhook removed." };
    }
    case "rebuild": {
      inBackground("rebuild", runRebuild(shop.id));
      return { ok: "Rebuild started. Inventory is refreshed and every forecast recalculated." };
    }
    case "demo-load": {
      if (!demoAllowed(shop)) return null;
      const r = await seedDemo(shop.id);
      return { ok: `Demo data loaded: ${r.forecasted} variants forecast.` };
    }
    case "demo-clear": {
      if (!demoAllowed(shop)) return null;
      await clearDemo(shop.id);
      inBackground("rebuild", runRebuild(shop.id, { refreshCatalog: false }));
      return { ok: "Demo data removed." };
    }
    case "wa-code": {
      if (!hasFeature(shop.plan, "phoneAlerts")) return { error: "The WhatsApp assistant is on the Scale and Pro plans." };
      if (!whatsappProvider()) return { error: "WhatsApp is not switched on for this app yet." };
      const code = await createLinkCode(shop.id);
      const number = businessNumber();
      return {
        ok: "Send this code from the phone you want to connect. It works for 10 minutes.",
        waCode: code.code,
        waLink: number ? `https://wa.me/${number}?text=${encodeURIComponent(`link ${code.code}`)}` : null,
      };
    }
    case "wa-role": {
      const link = await db.whatsappLink.findFirst({ where: { id: String(form.get("id")), shop: shop.id } });
      if (!link) return { error: "Number not found." };
      await db.whatsappLink.update({ where: { id: link.id }, data: { canApprove: !link.canApprove } });
      return { ok: link.canApprove ? `${link.phone} can now only view.` : `${link.phone} can now approve changes.` };
    }
    case "wa-remove": {
      await db.whatsappLink.deleteMany({ where: { id: String(form.get("id")), shop: shop.id } });
      return { ok: "Number disconnected." };
    }
    case "clear-ask": {
      await db.askThread.deleteMany({ where: { shop: shop.id } });
      return { ok: "All Ask StockSense conversations were deleted." };
    }
    case "reimport": {
      // Show progress straight away; the import sets its own stages once it starts.
      await db.shop.update({ where: { id: shop.id }, data: { syncStatus: "RUNNING", syncStage: "Starting the import", syncError: null } });
      inBackground("full-sync", runFullSync(shop.id));
      return { ok: "Re-import started. Two years of history is imported in the background." };
    }
  }
  return null;
};

const SECTIONS = [
  { id: "general", label: "General", hint: "Store, plan and usage", icon: "M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { id: "appearance", label: "Appearance", hint: "Theme, accent, density", icon: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8zM7.5 12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" },
  { id: "forecasting", label: "Forecasting", hint: "Safety stock and reorders", icon: "M3 17l5-5 4 4 8-8M15 8h5v5" },
  { id: "promotions", label: "Promotions", hint: "Planned demand lift", icon: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01" },
  { id: "notifications", label: "Notifications", hint: "Email, Slack, SMS, WhatsApp", icon: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" },
  { id: "ask", label: "Ask StockSense", hint: "AI assistant and history", icon: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" },
  { id: "whatsapp", label: "WhatsApp", hint: "Menus, AI and approvals", icon: "M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.4zM9 9.5c.3 2 2.5 4.3 4.6 4.8M9 9.5l1-1.2M13.6 14.3l1.3-.9" },
  { id: "api", label: "API & webhooks", hint: "Keys and endpoints", icon: "M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" },
  { id: "data", label: "Data & sync", hint: "Imports and privacy", icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ss-fact">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Meter({ used, limit }: { used: number; limit: number | null }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  return (
    <div className="ss-meter" aria-hidden="true">
      <i style={{ width: limit === null ? "6%" : `${pct}%` }} className={pct >= 90 ? "hot" : ""} />
    </div>
  );
}

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const s = d.shop;
  const [params] = useSearchParams();
  const raw = params.get("section");
  const section: SectionId = SECTIONS.some((x) => x.id === raw) ? (raw as SectionId) : "general";
  const meta = SECTIONS.find((x) => x.id === section)!;

  return (
    <Page eyebrow="Settings" title="Make it" accent="yours" subtitle="Everything StockSense does for your store, in one place.">
      <div className="ss-settings">
        <nav className="ss-settings-nav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <Link key={x.id} to={`?section=${x.id}`} preventScrollReset className="ss-settings-link" aria-current={x.id === section ? "page" : undefined}>
              <span className="ss-settings-ico">
                <Icon d={x.icon} />
              </span>
              <span className="ss-settings-txt">
                <b>{x.label}</b>
                <small>{x.hint}</small>
              </span>
            </Link>
          ))}
          <Link to="/app/billing" className="ss-settings-link plan">
            <span className="ss-settings-ico">
              <Icon d="M3 7h18v10H3zM3 11h18" />
            </span>
            <span className="ss-settings-txt">
              <b>Plan & billing</b>
              <small>{d.store.plan}</small>
            </span>
          </Link>
        </nav>

        <div className="ss-settings-body">
          <header className="ss-settings-head">
            <span className="ss-settings-ico big">
              <Icon d={meta.icon} />
            </span>
            <div>
              <h2>{meta.label}</h2>
              <p>{meta.hint}</p>
            </div>
          </header>

          {result && "ok" in result && (
            <Banner tone="success" title={result.ok}>
              {"key" in result && result.key && <code className="ss-code">{result.key}</code>}
            </Banner>
          )}
          {result && "error" in result && <Banner tone="critical" title={result.error} />}

          {section === "general" && (
            <>
              <Card title="Store" subtitle="Read from Shopify on every catalog sync.">
                <div className="ss-facts">
                  <Fact label="Store name" value={d.store.name} />
                  <Fact label="Domain" value={<span className="ss-mono">{d.store.domain}</span>} />
                  <Fact label="Contact email" value={d.store.email || "—"} />
                  <Fact label="Currency" value={d.store.currency} />
                  <Fact label="Time zone" value={d.store.timezone} />
                  <Fact label="Installed" value={timeAgo(d.store.installedAt)} />
                </div>
              </Card>
              <Card
                title="Plan and usage"
                meta={d.store.interval ? d.store.interval.toLowerCase() : undefined}
                actions={
                  <Link to="/app/billing" className="ss-btn small">
                    Change plan
                  </Link>
                }
              >
                <div className="ss-usage">
                  <div>
                    <Row>
                      <span className="ss-strong">{d.store.plan}</span>
                      {d.store.rebuild && <Badge tone="info">{d.store.rebuild}</Badge>}
                    </Row>
                  </div>
                  <div className="ss-usage-row">
                    <span>SKUs forecast</span>
                    <b>
                      {d.store.variants.toLocaleString()} / {d.store.skuLimit === null ? "unlimited" : d.store.skuLimit.toLocaleString()}
                    </b>
                    <Meter used={d.store.variants} limit={d.store.skuLimit} />
                  </div>
                  <div className="ss-usage-row">
                    <span>Locations</span>
                    <b>
                      {d.store.locations} / {d.store.locationLimit === null ? "unlimited" : d.store.locationLimit}
                    </b>
                    <Meter used={d.store.locations} limit={d.store.locationLimit} />
                  </div>
                  <div className="ss-usage-row">
                    <span>Ask StockSense this month</span>
                    <b>
                      {d.ask.used} / {d.ask.quota === null ? "unlimited" : d.ask.quota}
                    </b>
                    <Meter used={d.ask.used} limit={d.ask.quota} />
                  </div>
                </div>
              </Card>
              <Card title="Health">
                <div className="ss-facts">
                  <Fact label="Sync status" value={<Badge tone={s.syncStatus === "READY" ? "success" : s.syncStatus === "ERROR" ? "critical" : "info"}>{s.syncStatus.toLowerCase()}</Badge>} />
                  <Fact label="Last full import" value={s.lastFullSyncAt ? timeAgo(s.lastFullSyncAt) : "never"} />
                  <Fact label="Last forecast" value={s.lastForecastAt ? timeAgo(s.lastForecastAt) : "never"} />
                  <Fact label="Notifications" value={[
                        s.notifyEmail && s.alertEmail ? "email" : null,
                        s.notifySlack && s.slackWebhookUrl ? "Slack" : null,
                        s.notifySms && s.alertPhone ? "SMS" : null,
                        s.notifyWhatsapp && s.alertPhone ? "WhatsApp" : null,
                      ].filter(Boolean).join(" + ") || "off"} />
                </div>
              </Card>
            </>
          )}

          {section === "appearance" && <AppearanceCard />}

          {section === "forecasting" && (
            <Card title="Forecasting and reorder rules" subtitle="Saving rebuilds every forecast with the new settings.">
              <Form method="post">
                <input type="hidden" name="intent" value="forecasting" />
                <Stack>
                  <div className="ss-setting-group">
                    <h4>Safety stock</h4>
                    <FormGrid>
                      <Input label="Service level (%)" type="number" name="serviceLevel" min={50} max={99.9} step={0.5} defaultValue={String(Math.round(s.serviceLevel * 1000) / 10)} help="Chance of not running out during lead time. Higher means more safety stock." />
                      <Input label="Default lead time (days)" type="number" name="defaultLeadTimeDays" min={1} max={180} defaultValue={String(s.defaultLeadTimeDays)} help="Used for suppliers with no lead time set" />
                    </FormGrid>
                  </div>
                  <div className="ss-setting-group">
                    <h4>Ordering</h4>
                    <FormGrid>
                      <Input label="Order coverage (days)" type="number" name="coverageDays" min={7} max={365} defaultValue={String(s.coverageDays)} help="Days of demand each purchase order covers after it lands" />
                      <Input label="Overstock above (days of cover)" type="number" name="overstockDays" min={30} max={730} defaultValue={String(s.overstockDays)} help="Cover above this is flagged as cash tied up" />
                    </FormGrid>
                  </div>
                  <div className="ss-setting-group">
                    <h4>Alerts</h4>
                    <FormGrid>
                      <Input label="Velocity alert at (x normal)" type="number" name="velocityThreshold" min={1.2} max={10} step={0.1} defaultValue={String(s.velocityThreshold)} help="Fires when a SKU sells this many times faster than its 4-week pace" />
                    </FormGrid>
                  </div>
                  <div>
                    <Btn type="submit" variant="primary" loading={busy}>
                      Save forecasting settings
                    </Btn>
                  </div>
                </Stack>
              </Form>
            </Card>
          )}

          {section === "promotions" && (
            <>
              <Card title="Add a promotion" subtitle="Planned sales lift the forecast on those days. Past promotions are detected from discounted orders automatically.">
                <Form method="post">
                  <input type="hidden" name="intent" value="add-promo" />
                  <Stack>
                    <FormGrid min={180}>
                      <Input label="Name" name="name" placeholder="Black Friday" />
                      <Input label="Starts" type="date" name="startDate" required />
                      <Input label="Ends" type="date" name="endDate" />
                      <Input label="Expected uplift (%)" type="number" name="upliftPct" min={1} defaultValue="30" />
                      <Select label="Applies to" name="scope" defaultValue="ALL">
                        <option value="ALL">All products</option>
                        <option value="VENDOR">One vendor</option>
                        <option value="PRODUCT_TYPE">One product type</option>
                      </Select>
                      <Select label="Vendor (if one vendor)" name="vendor">
                        {d.vendors.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </Select>
                      <Select label="Product type (if one type)" name="productType">
                        {d.productTypes.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                    </FormGrid>
                    <div>
                      <Btn type="submit" variant="primary" loading={busy}>
                        Add promotion
                      </Btn>
                    </div>
                  </Stack>
                </Form>
              </Card>
              <Card title="Promotion calendar" meta={`${d.promotions.length}`}>
                {d.promotions.length === 0 ? (
                  <span className="ss-muted">No promotions planned.</span>
                ) : (
                  <List>
                    {d.promotions.map((p) => (
                      <ListRow
                        key={p.id}
                        left={
                          <div className="ss-item">
                            <span className="ss-strong">{p.name}</span>
                            <span className="ss-sku">
                              {p.startDate} → {p.endDate} · +{p.upliftPct}% · {p.scope === "ALL" ? "all products" : `${p.scope === "VENDOR" ? "vendor" : "type"} ${p.scopeValue}`}
                            </span>
                          </div>
                        }
                        right={
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete-promo" />
                            <input type="hidden" name="id" value={p.id} />
                            <Btn type="submit" small variant="danger">
                              Remove
                            </Btn>
                          </Form>
                        }
                      />
                    ))}
                  </List>
                )}
              </Card>
            </>
          )}

          {section === "notifications" && (
            <Card title="Alerts and notifications" subtitle="Where StockSense tells you about stockout risks, reorder points and drifting lead times.">
              <Stack>
                <Form method="post">
                  <input type="hidden" name="intent" value="notifications" />
                  <Stack>
                    <div className="ss-setting-group">
                      <h4>Email</h4>
                      <FormGrid min={280}>
                        <Input label="Alert email" type="email" name="alertEmail" defaultValue={s.alertEmail} />
                      </FormGrid>
                      <Check name="notifyEmail" label="Email me when an alert needs action" defaultChecked={s.notifyEmail} />
                    </div>
                    <div className="ss-setting-group">
                      <h4>Slack</h4>
                      {d.features.slack ? (
                        <>
                          <FormGrid min={280}>
                            <Input label="Slack incoming webhook URL" type="url" name="slackWebhookUrl" defaultValue={s.slackWebhookUrl} help="Slack > Apps > Incoming Webhooks" />
                          </FormGrid>
                          <Check name="notifySlack" label="Post alerts to Slack" defaultChecked={s.notifySlack} />
                        </>
                      ) : (
                        <span className="ss-muted ss-small">
                          Slack alerts are included from the Scale plan. <Link to="/app/billing">See plans</Link>
                        </span>
                      )}
                    </div>
                    <div className="ss-setting-group">
                      <h4>Text message and WhatsApp</h4>
                      {d.features.phone ? (
                        <>
                          <FormGrid min={280}>
                            <Input
                              label="Mobile number"
                              type="tel"
                              name="alertPhone"
                              defaultValue={s.alertPhone}
                              placeholder="+91 98765 43210"
                              autoComplete="tel"
                              help="With the country code"
                            />
                          </FormGrid>
                          <Row>
                            <Check name="notifySms" label="Send alerts by text message (SMS)" defaultChecked={s.notifySms} />
                            <Check name="notifyWhatsapp" label="Send alerts on WhatsApp" defaultChecked={s.notifyWhatsapp} />
                          </Row>
                          <Check name="phoneUrgentOnly" label="Only urgent alerts (stockout risk and reorder point)" defaultChecked={s.phoneUrgentOnly} />
                          {d.phoneReady.whatsappJoin && (
                            <span className="ss-muted ss-small">
                              For WhatsApp, first send <code className="ss-code">{d.phoneReady.whatsappJoin.code}</code> to {d.phoneReady.whatsappJoin.number} from your phone, once.{" "}
                              <a href={d.phoneReady.whatsappJoin.link} target="_blank" rel="noreferrer">
                                Open WhatsApp
                              </a>
                            </span>
                          )}
                          {(!d.phoneReady.sms || !d.phoneReady.whatsapp) && (
                            <span className="ss-muted ss-small">
                              {!d.phoneReady.sms && !d.phoneReady.whatsapp
                                ? "Text and WhatsApp alerts are not switched on for this app yet. Your settings are saved and start working as soon as they are."
                                : !d.phoneReady.sms
                                  ? "Text message alerts are not switched on for this app yet; WhatsApp works now."
                                  : "WhatsApp alerts are not switched on for this app yet; text messages work now."}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="ss-muted ss-small">
                          Text message and WhatsApp alerts are included from the Scale plan. <Link to="/app/billing">See plans</Link>
                        </span>
                      )}
                    </div>
                    <Row>
                      <Btn type="submit" variant="primary" loading={busy}>
                        Save notifications
                      </Btn>
                    </Row>
                  </Stack>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="test-notify" />
                  <Btn type="submit" variant="ghost">
                    Send a test alert
                  </Btn>
                </Form>
              </Stack>
            </Card>
          )}

          {section === "whatsapp" && <WhatsappSection d={d.whatsapp} result={result} busy={busy} />}

          {section === "ask" && (
            <>
              <Card title="Assistant" meta={d.ask.configured ? "connected" : "not configured"}>
                <Stack>
                  {!d.ask.configured && (
                    <Banner tone="warning" title="Set ANTHROPIC_API_KEY on the server to turn on Ask StockSense." />
                  )}
                  <div className="ss-facts">
                    <Fact label="Questions this month" value={`${d.ask.used} / ${d.ask.quota === null ? "unlimited" : d.ask.quota}`} />
                    <Fact label="Period started" value={timeAgo(d.ask.periodStart)} />
                    <Fact label="Saved conversations" value={d.ask.threads} />
                  </div>
                  <span className="ss-muted ss-small">
                    Open the assistant from the floating button at the bottom right of every page, or press Ctrl + J. Answers use your live forecasts and can include charts and draft purchase orders.
                  </span>
                  <Row>
                    <Link to="/app/ask" className="ss-btn primary">
                      Open full-page chat
                    </Link>
                  </Row>
                </Stack>
              </Card>
              <Card title="Chat history" subtitle="Conversations are stored in this app's database for your store only.">
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!window.confirm("Delete every saved conversation? This cannot be undone.")) e.preventDefault();
                    else {
                      try {
                        window.localStorage.removeItem("stocksense-ask-thread");
                      } catch {
                        // ignore
                      }
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="clear-ask" />
                  <Row>
                    <span className="ss-text-2">{d.ask.threads} saved conversation{d.ask.threads === 1 ? "" : "s"}</span>
                    <Btn type="submit" variant="danger" disabled={d.ask.threads === 0}>
                      Delete all conversations
                    </Btn>
                  </Row>
                </Form>
              </Card>
            </>
          )}

          {section === "api" && (
            <Card title="REST API and webhooks" meta={d.features.api ? `${RATE_LIMIT_PER_MINUTE} req/min per key` : "pro"}>
              {!d.features.api ? (
                <span className="ss-muted">
                  Full read and write REST API, webhooks on every alert and sandbox keys are included on the Pro plan. <Link to="/app/billing">See plans</Link>
                </span>
              ) : (
                <Stack>
                  <span className="ss-text-2 ss-small">
                    Base URL <span className="ss-mono">{d.appUrl}/api/v1</span> · Authorization: Bearer &lt;key&gt;. Sandbox keys read live data but writes are not saved.
                  </span>
                  {d.keys.length > 0 && (
                    <List>
                      {d.keys.map((k) => (
                        <ListRow
                          key={k.id}
                          left={
                            <div className="ss-item">
                              <span className="ss-strong">{k.name}</span>
                              <span className="ss-sku">
                                {k.prefix}… {k.sandbox ? "· sandbox" : ""} · {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}
                              </span>
                            </div>
                          }
                          right={
                            <Form method="post">
                              <input type="hidden" name="intent" value="revoke-key" />
                              <input type="hidden" name="id" value={k.id} />
                              <Btn type="submit" small variant="danger">
                                Revoke
                              </Btn>
                            </Form>
                          }
                        />
                      ))}
                    </List>
                  )}
                  <Form method="post">
                    <input type="hidden" name="intent" value="create-key" />
                    <div className="ss-input-group">
                      <Input label="Key name" name="name" placeholder="ERP integration" />
                      <Check name="sandbox" label="Sandbox" />
                      <Btn type="submit">Create key</Btn>
                    </div>
                  </Form>
                  <hr className="ss-divider" />
                  <span className="ss-strong">Webhooks</span>
                  <span className="ss-muted ss-small">
                    Signed with HMAC SHA-256: X-StockSense-Signature = sha256=hex(hmac(secret, timestamp + &quot;.&quot; + body)). Events: alert.stockout_risk, alert.reorder_point, alert.velocity_shift,
                    alert.lead_time_drift, alert.overstock, purchase_order.approved, purchase_order.sent, purchase_order.received.
                  </span>
                  {d.hooks.length > 0 && (
                    <List>
                      {d.hooks.map((h) => (
                        <ListRow
                          key={h.id}
                          left={
                            <div className="ss-item">
                              <span className="ss-mono ss-small">{h.url}</span>
                              <span className="ss-sku">
                                {h.events} · secret {h.secret.slice(0, 6)}… · last status {h.lastStatus ?? "none"}
                              </span>
                            </div>
                          }
                          right={
                            <Form method="post">
                              <input type="hidden" name="intent" value="delete-hook" />
                              <input type="hidden" name="id" value={h.id} />
                              <Btn type="submit" small variant="danger">
                                Remove
                              </Btn>
                            </Form>
                          }
                        />
                      ))}
                    </List>
                  )}
                  <Form method="post">
                    <input type="hidden" name="intent" value="add-hook" />
                    <div className="ss-input-group">
                      <div style={{ flex: "1 1 320px" }}>
                        <Input label="Endpoint URL" type="url" name="url" placeholder="https://example.com/stocksense" />
                      </div>
                      <Input label="Events" name="events" defaultValue="*" />
                      <Btn type="submit">Add webhook</Btn>
                    </div>
                  </Form>
                </Stack>
              )}
            </Card>
          )}

          {section === "data" && (
            <>
              <Card title="Sync" meta={`${s.syncStatus.toLowerCase()}${s.syncStage ? ` · ${s.syncStage}` : ""}`}>
                <Stack>
                  <span className="ss-text-2 ss-small">
                    Last full import {s.lastFullSyncAt ? timeAgo(s.lastFullSyncAt) : "never"} · last forecast {s.lastForecastAt ? timeAgo(s.lastForecastAt) : "never"}
                  </span>
                  <div className="ss-action-rows">
                    <Form method="post" className="ss-action-row">
                      <input type="hidden" name="intent" value="rebuild" />
                      <div>
                        <b>Rebuild forecasts now</b>
                        <span>Refreshes inventory, pulls the last 3 days of orders and recalculates every forecast.</span>
                      </div>
                      <Btn type="submit" variant="primary" loading={busy}>
                        Rebuild
                      </Btn>
                    </Form>
                    <Form method="post" className="ss-action-row">
                      <input type="hidden" name="intent" value="reimport" />
                      <div>
                        <b>Re-import order history</b>
                        <span>Imports two years of orders again in the background. Use this if history looks incomplete.</span>
                      </div>
                      <Btn type="submit">Re-import</Btn>
                    </Form>
                  </div>
                </Stack>
              </Card>
              {d.demoAllowed && (
                <Card title="Demo data" subtitle="For development stores with no order history.">
                  <Row>
                    <Form method="post">
                      <input type="hidden" name="intent" value="demo-load" />
                      <Btn type="submit" loading={busy}>
                        Load demo data
                      </Btn>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="demo-clear" />
                      <Btn type="submit" variant="ghost">
                        Remove demo data
                      </Btn>
                    </Form>
                  </Row>
                </Card>
              )}
              <Card title="Privacy">
                <span className="ss-text-2">
                  Your data is read through scoped Shopify credentials and stays in this app&apos;s database. Nothing is pooled across merchants and nothing trains a shared model. Uninstalling removes
                  your store&apos;s data within 48 hours.
                </span>
              </Card>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

/** Appearance is a per-browser preference, saved instantly in local storage. */
function AppearanceCard() {
  const a = useAppearance();
  const themes: { id: Theme; label: string; colors: [string, string, string] }[] = [
    { id: "dark", label: "Dark", colors: ["#0f0d0c", "#1f1b18", "#f26b1d"] },
    { id: "light", label: "Light", colors: ["#f4efe7", "#fffdf9", "#f26b1d"] },
    { id: "default", label: "Default", colors: ["#f1f1f1", "#ffffff", "#303030"] },
  ];
  return (
    <Card title="Look and feel" subtitle="Saved in this browser and applied instantly. The theme switch in every page header does the same.">
      <Stack>
        <div className="ss-field">
          <span className="ss-label">Theme</span>
          <div className="ss-theme-cards">
            {themes.map((t) => (
              <button key={t.id} type="button" className="ss-theme-card" aria-pressed={a.theme === t.id} onClick={() => saveAppearance({ theme: t.id })}>
                <span className="ss-theme-preview" style={{ background: t.colors[0] }}>
                  <i style={{ background: t.colors[1] }} />
                  <i style={{ background: t.colors[1] }} />
                  <i style={{ background: t.colors[2], gridColumn: "span 2", height: 8 }} />
                </span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ss-field">
          <span className="ss-label">Accent colour</span>
          <div className="ss-swatches">
            {ACCENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="ss-swatch"
                style={{ background: c.color }}
                aria-pressed={a.accent === c.id}
                aria-label={c.label}
                title={c.label}
                onClick={() => saveAppearance({ accent: c.id })}
              />
            ))}
          </div>
        </div>
        <div className="ss-field">
          <span className="ss-label">Layout density</span>
          <div className="ss-toggle" role="group" aria-label="Layout density">
            {(["comfortable", "compact"] as Density[]).map((x) => (
              <button key={x} type="button" aria-pressed={a.density === x} onClick={() => saveAppearance({ density: x })}>
                {x === "comfortable" ? "Comfortable" : "Compact"}
              </button>
            ))}
          </div>
        </div>
      </Stack>
    </Card>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

const ACTION_LABEL: Record<string, string> = {
  CREATE_DRAFT_PO: "Draft purchase order",
  APPROVE_PO: "Approve purchase order",
  SEND_PO: "Send purchase order",
  RECEIVE_PO: "Receive stock",
  ADD_SUPPLIER: "Add supplier",
  UPDATE_SUPPLIER: "Update supplier",
  SET_PREFERRED_SUPPLIER: "Preferred supplier",
  UPDATE_REORDER_RULES: "Reorder rules",
  DISMISS_ALERT: "Dismiss alert",
  CREATE_TRANSFER: "Draft transfer",
};
const ACTION_TONE: Record<string, "success" | "critical" | "warning" | "neutral" | "info"> = {
  DONE: "success",
  FAILED: "critical",
  PENDING: "warning",
  CONFIRMING: "warning",
  RUNNING: "info",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

type WhatsappData = ReturnType<typeof useLoaderData<typeof loader>>["whatsapp"];

/** Connect phones to the WhatsApp assistant, choose who can approve, and see what was done. */
function WhatsappSection({ d, result, busy }: { d: WhatsappData; result: unknown; busy: boolean }) {
  const r = (result ?? {}) as { waCode?: string; waLink?: string | null };
  if (!d.allowed) {
    return (
      <Card title="WhatsApp assistant">
        <span className="ss-muted">
          Manage stock, purchase orders and suppliers from WhatsApp, with menus and AI. Included in the Scale and Pro plans. <Link to="/app/billing">See plans</Link>
        </span>
      </Card>
    );
  }
  return (
    <>
      <Card
        title="WhatsApp assistant"
        meta={d.provider ? `on · ${d.provider === "meta" ? "WhatsApp Cloud API" : "Twilio"}` : "not switched on"}
        subtitle="Menus for every feature, like your bank's WhatsApp, plus questions in your own words. Every change asks for approval first. Nothing can be deleted from WhatsApp."
      >
        <Stack>
          {!d.provider && <Banner tone="warning" title="WhatsApp is not switched on for this app yet. Connected numbers start working as soon as it is." />}
          {!d.ai && d.provider && <span className="ss-muted ss-small">AI answers need ANTHROPIC_API_KEY on the server. Until then, menus work and typed text searches products.</span>}
          {r.waCode ? (
            <div className="ss-wa-code">
              <span className="ss-muted ss-small">From the phone you want to connect, send</span>
              <b className="ss-mono">link {r.waCode}</b>
              <span className="ss-muted ss-small">to {d.number ? `+${d.number}` : "the StockSense WhatsApp number"} within 10 minutes.</span>
              {r.waLink && (
                <a className="ss-btn primary" href={r.waLink} target="_blank" rel="noreferrer">
                  Open WhatsApp with the code
                </a>
              )}
            </div>
          ) : null}
          <Form method="post">
            <input type="hidden" name="intent" value="wa-code" />
            <Btn type="submit" variant={r.waCode ? "ghost" : "primary"} loading={busy} disabled={!d.provider}>
              {r.waCode ? "New code" : "Connect a phone"}
            </Btn>
          </Form>
        </Stack>
      </Card>

      <Card title="Connected numbers" meta={String(d.links.length)}>
        {d.links.length === 0 ? (
          <span className="ss-muted">No numbers yet.</span>
        ) : (
          <List>
            {d.links.map((l) => (
              <ListRow
                key={l.id}
                left={
                  <div className="ss-item">
                    <span className="ss-strong ss-mono">{l.phone}</span>
                    <span className="ss-sku">
                      connected {timeAgo(l.createdAt)} · {l.lastInboundAt ? `last message ${timeAgo(l.lastInboundAt)}` : "no messages yet"}
                    </span>
                  </div>
                }
                right={
                  <Row>
                    <Badge tone={l.canApprove ? "success" : "neutral"}>{l.canApprove ? "can approve" : "view only"}</Badge>
                    <Form method="post">
                      <input type="hidden" name="intent" value="wa-role" />
                      <input type="hidden" name="id" value={l.id} />
                      <Btn type="submit" small variant="ghost">
                        {l.canApprove ? "Make view only" : "Allow approvals"}
                      </Btn>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="wa-remove" />
                      <input type="hidden" name="id" value={l.id} />
                      <Btn type="submit" small variant="danger">
                        Disconnect
                      </Btn>
                    </Form>
                  </Row>
                }
              />
            ))}
          </List>
        )}
      </Card>

      <Card title="What was asked and done on WhatsApp" subtitle="Every change proposed by the menus or the AI, and whether it was approved.">
        {d.actions.length === 0 ? (
          <span className="ss-muted">Nothing yet.</span>
        ) : (
          <List>
            {d.actions.map((a) => (
              <ListRow
                key={a.id}
                left={
                  <div className="ss-item">
                    <span className="ss-strong">
                      {ACTION_LABEL[a.type] ?? a.type} <span className="ss-muted ss-small">· {a.source === "AI" ? "AI" : "menu"}</span>
                    </span>
                    <span className="ss-sku">
                      {a.summary.split("\n")[0]} · {a.phone} · {timeAgo(a.createdAt)}
                      {a.result && a.status !== "DONE" ? ` · ${a.result}` : ""}
                    </span>
                  </div>
                }
                right={<Badge tone={ACTION_TONE[a.status] ?? "neutral"}>{a.status.toLowerCase()}</Badge>}
              />
            ))}
          </List>
        )}
      </Card>
    </>
  );
}
