-- CreateTable
CREATE TABLE "WhatsappLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "label" TEXT,
    "canApprove" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT,
    "threadId" TEXT,
    "lastInboundAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WhatsappCode" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'MENU',
    "expiresAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WhatsappInbound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WhatsappMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappLink_phone_key" ON "WhatsappLink"("phone");

-- CreateIndex
CREATE INDEX "WhatsappLink_shop_idx" ON "WhatsappLink"("shop");

-- CreateIndex
CREATE INDEX "PendingAction_shop_createdAt_idx" ON "PendingAction"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "PendingAction_phone_status_idx" ON "PendingAction"("phone", "status");

