-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "plan" TEXT NOT NULL DEFAULT 'NONE',
    "billingInterval" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncStage" TEXT,
    "syncError" TEXT,
    "lastFullSyncAt" DATETIME,
    "lastInventorySyncAt" DATETIME,
    "lastForecastAt" DATETIME,
    "jobLockedUntil" DATETIME,
    "serviceLevel" REAL NOT NULL DEFAULT 0.95,
    "coverageDays" INTEGER NOT NULL DEFAULT 60,
    "overstockDays" INTEGER NOT NULL DEFAULT 90,
    "defaultLeadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "velocityThreshold" REAL NOT NULL DEFAULT 1.8,
    "alertEmail" TEXT,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "slackWebhookUrl" TEXT,
    "notifySlack" BOOLEAN NOT NULL DEFAULT false,
    "dailyDigest" BOOLEAN NOT NULL DEFAULT true,
    "askPeriodStart" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "askQuestionsUsed" INTEGER NOT NULL DEFAULT 0,
    "nextPoNumber" INTEGER NOT NULL DEFAULT 1001,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "vendorKey" TEXT,
    "defaultLeadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "minOrderValue" REAL NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LeadTimeObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "days" REAL NOT NULL,
    "source" TEXT NOT NULL,
    "poId" TEXT,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadTimeObservation_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "imageUrl" TEXT,
    "price" REAL NOT NULL DEFAULT 0,
    "unitCost" REAL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "tracked" BOOLEAN NOT NULL DEFAULT true,
    "supplierId" TEXT,
    "casePack" INTEGER NOT NULL DEFAULT 1,
    "minOrderQty" INTEGER NOT NULL DEFAULT 0,
    "leadTimeOverride" INTEGER,
    "firstSoldAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Variant_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryLevel" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "incoming" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("variantId", "locationId")
);

-- CreateTable
CREATE TABLE "SalesDaily" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL DEFAULT '',
    "date" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "revenue" REAL NOT NULL DEFAULT 0,
    "discountUnits" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("variantId", "locationId", "date")
);

-- CreateTable
CREATE TABLE "ProcessedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "upliftPct" REAL NOT NULL DEFAULT 30,
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "scopeValue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Forecast" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL DEFAULT '',
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "historyDays" INTEGER NOT NULL,
    "dailyRate14" REAL NOT NULL,
    "meanDaily" REAL NOT NULL,
    "sigmaDaily" REAL NOT NULL,
    "series" TEXT NOT NULL,
    "lower" TEXT NOT NULL,
    "upper" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL,
    "onOrder" INTEGER NOT NULL,
    "leadTimeDays" REAL NOT NULL,
    "safetyStock" REAL NOT NULL,
    "reorderPoint" REAL NOT NULL,
    "daysOfCover" REAL NOT NULL,
    "stockoutDate" TEXT,
    "suggestedQty" INTEGER NOT NULL,
    "revenueAtRisk" REAL NOT NULL,
    "overstockUnits" REAL NOT NULL,
    "overstockValue" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "accuracy" REAL,

    PRIMARY KEY ("variantId", "locationId")
);

-- CreateTable
CREATE TABLE "AccuracySnapshot" (
    "shop" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "accuracy" REAL NOT NULL,
    "skuCount" INTEGER NOT NULL,

    PRIMARY KEY ("shop", "date")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "variantId" TEXT,
    "supplierId" TEXT,
    "locationId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "revenueAtRisk" REAL NOT NULL DEFAULT 0,
    "dedupeKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "poId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "notifiedAt" DATETIME,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "notes" TEXT,
    "expectedAt" DATETIME,
    "approvedAt" DATETIME,
    "orderedAt" DATETIME,
    "receivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" REAL NOT NULL DEFAULT 0,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PurchaseOrderLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AskThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AskMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "raw" TEXT,
    "poId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AskMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AskThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '*',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" INTEGER,
    "lastSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Location_shop_idx" ON "Location"("shop");

-- CreateIndex
CREATE INDEX "Supplier_shop_idx" ON "Supplier"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_shop_name_key" ON "Supplier"("shop", "name");

-- CreateIndex
CREATE INDEX "LeadTimeObservation_shop_supplierId_observedAt_idx" ON "LeadTimeObservation"("shop", "supplierId", "observedAt");

-- CreateIndex
CREATE INDEX "Variant_shop_idx" ON "Variant"("shop");

-- CreateIndex
CREATE INDEX "Variant_shop_sku_idx" ON "Variant"("shop", "sku");

-- CreateIndex
CREATE INDEX "Variant_inventoryItemId_idx" ON "Variant"("inventoryItemId");

-- CreateIndex
CREATE INDEX "InventoryLevel_shop_idx" ON "InventoryLevel"("shop");

-- CreateIndex
CREATE INDEX "SalesDaily_shop_date_idx" ON "SalesDaily"("shop", "date");

-- CreateIndex
CREATE INDEX "ProcessedOrder_shop_idx" ON "ProcessedOrder"("shop");

-- CreateIndex
CREATE INDEX "Promotion_shop_idx" ON "Promotion"("shop");

-- CreateIndex
CREATE INDEX "Forecast_shop_status_idx" ON "Forecast"("shop", "status");

-- CreateIndex
CREATE INDEX "Forecast_shop_locationId_idx" ON "Forecast"("shop", "locationId");

-- CreateIndex
CREATE INDEX "Alert_shop_status_idx" ON "Alert"("shop", "status");

-- CreateIndex
CREATE INDEX "Alert_shop_dedupeKey_idx" ON "Alert"("shop", "dedupeKey");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shop_status_idx" ON "PurchaseOrder"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_shop_number_key" ON "PurchaseOrder"("shop", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_poId_idx" ON "PurchaseOrderLine"("poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_variantId_idx" ON "PurchaseOrderLine"("variantId");

-- CreateIndex
CREATE INDEX "AskThread_shop_idx" ON "AskThread"("shop");

-- CreateIndex
CREATE INDEX "AskMessage_threadId_idx" ON "AskMessage"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");

-- CreateIndex
CREATE INDEX "ApiKey_shop_idx" ON "ApiKey"("shop");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_shop_idx" ON "WebhookEndpoint"("shop");
