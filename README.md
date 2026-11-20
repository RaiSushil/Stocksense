# StockSense

Demand forecasting and reordering for Shopify. StockSense forecasts demand for every
variant, warns you before a bestseller runs dry, and writes the purchase order for you.

Embedded Shopify app built on the official React Router app template, Polaris web
components, Prisma and the Admin GraphQL API (2026-10). "Ask StockSense" uses Claude.

## Features

| Area | What it does | Where |
| --- | --- | --- |
| Import | Locations, variants, cost, inventory per location, two years of orders (bulk operations). Suppliers are created from product vendors. | `app/lib/sync/*` |
| Forecasting | Per-variant curve: damped Holt on weekly totals, day-of-week and month seasonality, promotion detection and planned uplift, Croston for slow sellers, 80% band, 4-week backtest accuracy. Per-location forecasts on Scale and Pro. | `app/lib/forecast/engine.ts` |
| Reordering | Days of cover, safety stock (service level + lead-time variance), reorder point, suggested quantity (case pack, MOQ), revenue at risk, overstock at cost. | `app/lib/forecast/inventory.ts` |
| Supplier lead times | Rolling 90-day average from received POs, or the latest delivery if slower. Scorecards on Pro. | `app/lib/suppliers.server.ts` |
| Alerts | Stockout risk, reorder point, same-day velocity shifts (on the order webhook), lead-time drift, overstock. Ranked by revenue at risk, de-duplicated, re-notified only when something changes. Email, Slack, signed webhooks. | `app/lib/alerts/*` |
| Purchase orders | Automatic drafts per supplier, edit, approve, email to supplier with CSV, receive (adds stock in Shopify, records the real lead time). | `app/lib/po.server.ts` |
| Transfers (Pro) | Suggests moving surplus between locations and creates a draft Shopify transfer. | `app/lib/transfers.server.ts` |
| Ask StockSense | Claude with read tools over your own data plus a draft-PO tool. 100 questions a month on Scale, unlimited on Pro. | `app/lib/ask/*` |
| REST API (Pro) | `/api/v1/forecasts`, `/forecasts/:variantId`, `/alerts`, `/purchase-orders` (GET, POST, approve/send/cancel), `/suppliers`. Bearer keys, sandbox keys, 120 req/min. | `app/routes/api.v1.*` |
| Plans | Launch / Scale / Pro, monthly or annual (save 29%), 14-day trial through Shopify Billing, feature gates and SKU limits. | `app/lib/plans.ts` |

Admin pages: Dashboard, Forecasts (list, CSV export, SKU detail with projected stock
chart), Alerts, Purchase orders, Suppliers, Transfers, Ask StockSense, Settings
(forecasting, promotion calendar, notifications, API keys, webhooks, data), Plan.

## Run locally

Requirements: Node 22.12+, a Shopify Partner account and a development store.

```bash
npm install
cp .env.example .env            # keep DATABASE_URL; add ANTHROPIC_API_KEY for Ask
npx prisma migrate dev          # creates prisma/dev.sqlite
npm run config:link             # link shopify.app.toml to your app in the Dev Dashboard
STOCKSENSE_DEV_PLAN=PRO npm run dev
```

Open the app from your dev store. The first import starts on install. A new dev store
has no orders, so go to Settings and click **Load demo data** to see forecasts,
alerts and draft POs straight away.

`read_all_orders` must be requested in the Partner Dashboard (API access) before the
two-year import returns more than 60 days of orders.

## Tests

```bash
npm test          # forecasting unit tests + full pipeline test on demo data
npm run typecheck
npm run lint
```

## Deploy

1. Use PostgreSQL: set `provider = "postgresql"` in `prisma/schema.prisma`, delete
   `prisma/migrations`, run `npx prisma migrate dev --name init` against a Postgres
   database, and set `DATABASE_URL`.
2. Set the variables in `.env.example` on the host (`NODE_ENV=production`,
   `BILLING_TEST=false` for real charges).
3. Build and start: `npm run build && npm run setup && npm run start`, or use the
   Dockerfile.
4. `npm run deploy` pushes the app config, scopes and webhooks to Shopify.

The scheduler runs inside the app process (weekly, nightly or hourly rebuilds by plan).
For more than one instance, set `DISABLE_SCHEDULER=true` and call `POST /jobs/tick`
with `Authorization: Bearer $CRON_SECRET` every 5 minutes from a cron job.

## Webhook signature (Pro)

`X-StockSense-Signature: sha256=<hex>` where hex is
`HMAC-SHA256(secret, X-StockSense-Timestamp + "." + rawBody)`.

## Not included

The screenshot also shows BigCommerce, WooCommerce, Magento, Lightspeed, Square and
NetSuite connectors, multi-store rollups across separate shops, and the marketing
landing page. This repository is the Shopify app only.
