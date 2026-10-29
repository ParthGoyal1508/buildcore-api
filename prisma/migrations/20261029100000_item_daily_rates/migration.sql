-- 050: daily-changing item rates (diesel, cement). DDL from `prisma migrate diff` against the
-- scratch database; the RLS policy and the two partial unique keys are appended, as 037 and 048 do.

-- AlterTable
ALTER TABLE "settings"."Item" ADD COLUMN     "dailyRate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "machineFuel" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "inventory"."ItemDailyRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "vendorId" TEXT,
    "rate" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemDailyRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemDailyRate_companyId_itemId_effectiveFrom_idx" ON "inventory"."ItemDailyRate"("companyId", "itemId", "effectiveFrom");

-- One market row and one row per vendor, per item per day. Two partial indexes because a plain
-- unique key treats every NULL vendor as distinct, which would allow two market rates on one day.
CREATE UNIQUE INDEX "ItemDailyRate_market_day_key"
  ON "inventory"."ItemDailyRate"("companyId", "itemId", "effectiveFrom")
  WHERE "vendorId" IS NULL;
CREATE UNIQUE INDEX "ItemDailyRate_vendor_day_key"
  ON "inventory"."ItemDailyRate"("companyId", "itemId", "vendorId", "effectiveFrom")
  WHERE "vendorId" IS NOT NULL;

-- The standard tenant policy every inventory table carries.
ALTER TABLE "inventory"."ItemDailyRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."ItemDailyRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."ItemDailyRate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
