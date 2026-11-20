-- Development stores count test orders; SMS and WhatsApp alert settings.
ALTER TABLE "Shop" ADD COLUMN "isDevStore" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "alertPhone" TEXT;
ALTER TABLE "Shop" ADD COLUMN "notifySms" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "notifyWhatsapp" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "phoneUrgentOnly" BOOLEAN NOT NULL DEFAULT true;
