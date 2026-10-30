-- 051: opening stock, and the kilolitre unit. DDL from `prisma migrate diff` against the scratch
-- database; the RLS policy is appended, as 037, 048 and 050 do. A pre-existing unrelated index-rename
-- drift (`LeaveLedgerEntry`) that the diff also emitted was left out.

-- AlterEnum
ALTER TYPE "inventory"."StockLedgerType" ADD VALUE 'opening';

-- AlterEnum
ALTER TYPE "settings"."ItemUnit" ADD VALUE 'KL';

-- CreateTable
CREATE TABLE "inventory"."OpeningStock" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,2),
    "asOnDate" DATE NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpeningStock_companyId_siteId_idx" ON "inventory"."OpeningStock"("companyId", "siteId");

-- One opening entry per item per store.
CREATE UNIQUE INDEX "OpeningStock_itemId_siteId_key" ON "inventory"."OpeningStock"("itemId", "siteId");

-- The standard tenant policy every inventory table carries.
ALTER TABLE "inventory"."OpeningStock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."OpeningStock" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."OpeningStock"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
