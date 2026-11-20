import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { addDays, todayIn } from "../lib/dates";
import { money, num } from "../lib/format";
import { PLANS, TRIAL_DAYS, billingKey, parseBillingKey, type Interval, type PlanId } from "../lib/plans";
import { adminAppUrl } from "../lib/notify.server";
import { Badge, Banner, Btn, Card, Grid, Page, Pills, Row } from "../components/ui";

const isTest = () => process.env.BILLING_TEST === "true" || process.env.NODE_ENV !== "production";
const ALL_KEYS = Object.values(PLANS).flatMap((p) => [billingKey(p.id, "MONTHLY"), billingKey(p.id, "ANNUAL")]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, billing } = await adminContext(request);
  const url = new URL(request.url);
  const interval = (url.searchParams.get("interval") === "MONTHLY" ? "MONTHLY" : "ANNUAL") as Interval;

  // Source of truth is Shopify Billing: refresh the stored plan on every visit.
  let subscriptionId: string | null = null;
  if (!process.env.STOCKSENSE_DEV_PLAN) {
    const check = await billing.check({ plans: ALL_KEYS as any, isTest: isTest() });
    const active = check.appSubscriptions.find((s) => parseBillingKey(s.name));
    const parsed = active ? parseBillingKey(active.name) : null;
    subscriptionId = active?.id ?? null;
    const plan = parsed?.plan ?? "NONE";
    if (plan !== shop.plan || (parsed?.interval ?? null) !== shop.billingInterval) {
      await db.shop.update({ where: { id: shop.id }, data: { plan, billingInterval: parsed?.interval ?? null } });
      shop.plan = plan;
    }
  }

  // "Every variant you actively sell" counts: sold in the last year, or in stock.
  const today = todayIn(shop.timezone);
  const sold = await db.salesDaily.groupBy({ by: ["variantId"], where: { shop: shop.id, date: { gte: addDays(today, -365) }, units: { gt: 0 } } });
  const inStock = await db.inventoryLevel.groupBy({ by: ["variantId"], where: { shop: shop.id, available: { gt: 0 } } });
  const live = new Set([...sold.map((s) => s.variantId), ...inStock.map((s) => s.variantId)]).size;

  return {
    interval,
    current: shop.plan as PlanId,
    currentInterval: shop.billingInterval,
    subscriptionId,
    devPlan: process.env.STOCKSENSE_DEV_PLAN ?? null,
    liveSkus: live,
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      monthly: p.monthly,
      annual: p.annual,
      skuLimit: Number.isFinite(p.skuLimit) ? p.skuLimit : null,
      bullets: p.bullets,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await adminContext(request);
  const form = await request.formData();
  if (form.get("intent") === "cancel") {
    await billing.cancel({ subscriptionId: String(form.get("subscriptionId")), isTest: isTest(), prorate: true });
    await db.shop.update({ where: { id: session.shop }, data: { plan: "NONE", billingInterval: null } });
    return null;
  }
  const plan = String(form.get("plan")) as Exclude<PlanId, "NONE">;
  const interval = (String(form.get("interval")) === "MONTHLY" ? "MONTHLY" : "ANNUAL") as Interval;
  if (!(plan in PLANS)) return null;
  // Redirects the merchant to Shopify to approve the charge; the trial starts on approval.
  await billing.request({
    plan: billingKey(plan, interval) as any,
    isTest: isTest(),
    returnUrl: adminAppUrl(session.shop, "/app/billing"),
  });
  return null;
};

export default function Billing() {
  const d = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const pendingPlan = nav.state !== "idle" ? String(nav.formData?.get("plan") ?? "") : "";

  return (
    <Page
      eyebrow="Pricing"
      title="Simple,"
      accent="honest pricing"
      subtitle={`One stockout on a bestseller costs more than a year of any plan below. Every plan includes a ${TRIAL_DAYS}-day free trial, charged through your Shopify bill.`}
    >
      {d.devPlan && (
        <Banner tone="info" title={`Development mode: using the ${d.devPlan} plan`}>
          STOCKSENSE_DEV_PLAN is set, so billing is skipped.
        </Banner>
      )}
      {d.current === "NONE" && !d.devPlan && (
        <Banner tone="info" title="Choose a plan to start your free trial">
          Your store is already importing in the background, so forecasts will be ready when you are.
        </Banner>
      )}

      <Row between>
        <Pills
          base="/app/billing"
          param="interval"
          value={d.interval}
          options={[
            { value: "MONTHLY", label: "Monthly" },
            { value: "ANNUAL", label: "Annual · save 29%" },
          ]}
        />
        <span className="ss-card-meta">you sell {num(d.liveSkus)} active SKUs today</span>
      </Row>

      <Grid min={260}>
        {d.plans.map((p) => {
          const isCurrent = d.current === p.id && (d.currentInterval ?? d.interval) === d.interval;
          const perMonth = d.interval === "ANNUAL" ? p.annual / 12 : p.monthly;
          const tooSmall = p.skuLimit !== null && d.liveSkus > p.skuLimit;
          const [whole, cents] = perMonth.toFixed(2).split(".");
          return (
            <section key={p.id} className={`ss-card ss-plan${p.id === "SCALE" ? " featured" : ""}`}>
              <Row between>
                <span className="ss-plan-name">{p.name}</span>
                {isCurrent ? <Badge tone="success">current plan</Badge> : p.id === "SCALE" ? <Badge tone="accent">most chosen</Badge> : null}
              </Row>
              <span className="ss-text-2 ss-small">{p.tagline}</span>
              <div>
                <div className="ss-price">
                  <sup>$</sup>
                  {whole}.{cents}
                  <small> / month</small>
                </div>
                <span className="ss-sku">{d.interval === "ANNUAL" ? `${money(p.annual, "USD", 2)} billed once a year` : "billed every 30 days"}</span>
              </div>
              <Form method="post">
                <input type="hidden" name="plan" value={p.id} />
                <input type="hidden" name="interval" value={d.interval} />
                <Btn type="submit" block variant={p.id === "SCALE" ? "primary" : "secondary"} disabled={isCurrent || !!d.devPlan} loading={pendingPlan === p.id}>
                  {isCurrent ? "Current plan" : d.current === "NONE" ? "Start free trial" : "Switch to this plan"}
                </Btn>
              </Form>
              <ul className="ss-checks">
                {p.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {tooSmall && <Badge tone="warning">{`forecasts your top ${num(p.skuLimit!)} SKUs`}</Badge>}
            </section>
          );
        })}
      </Grid>

      <Card>
        <Row between>
          <div className="ss-item" style={{ maxWidth: 640 }}>
            <span className="ss-plan-name">Built for scale</span>
            <span className="ss-text-2">
              Running a wholesale arm, a 3PL, or more SKUs than Pro covers? We will size the forecasting model, the infrastructure and the price
              around what you actually hold.
            </span>
          </div>
          <Btn href="mailto:sales@athinfosys.com?subject=StockSense%20quote" variant="primary">
            Request a quote →
          </Btn>
        </Row>
      </Card>

      {d.subscriptionId && (
        <Form method="post">
          <input type="hidden" name="intent" value="cancel" />
          <input type="hidden" name="subscriptionId" value={d.subscriptionId} />
          <Btn type="submit" variant="danger">
            Cancel subscription
          </Btn>
        </Form>
      )}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
