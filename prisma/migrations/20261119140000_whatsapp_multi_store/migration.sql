-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WhatsappLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "canApprove" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT,
    "threadId" TEXT,
    "lastInboundAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_WhatsappLink" ("canApprove", "createdAt", "id", "label", "lastInboundAt", "phone", "shop", "state", "threadId") SELECT "canApprove", "createdAt", "id", "label", "lastInboundAt", "phone", "shop", "state", "threadId" FROM "WhatsappLink";
DROP TABLE "WhatsappLink";
ALTER TABLE "new_WhatsappLink" RENAME TO "WhatsappLink";
CREATE INDEX "WhatsappLink_phone_idx" ON "WhatsappLink"("phone");
CREATE UNIQUE INDEX "WhatsappLink_shop_phone_key" ON "WhatsappLink"("shop", "phone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

