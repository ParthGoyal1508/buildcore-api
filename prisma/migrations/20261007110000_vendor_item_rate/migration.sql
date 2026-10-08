-- AlterTable
ALTER TABLE "inventory"."Purchase" ADD COLUMN     "photoFileRef" TEXT;

-- CreateTable
CREATE TABLE "inventory"."VendorItemRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "establishedByPurchaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorItemRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorItemRate_companyId_idx" ON "inventory"."VendorItemRate"("companyId");

-- CreateIndex
CREATE INDEX "VendorItemRate_companyId_itemId_idx" ON "inventory"."VendorItemRate"("companyId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorItemRate_companyId_vendorId_itemId_effectiveFrom_key" ON "inventory"."VendorItemRate"("companyId", "vendorId", "itemId", "effectiveFrom");


-- Row-level security (Principle IV, non-negotiable).
--
-- Appended to the generated DDL rather than hand-edited into it: Prisma cannot express a policy, so
-- every table in this database carries one added exactly this way — see
-- `20260903203459_inventory_rls_policies`, which is where `Purchase` and its siblings got theirs.
-- The generated half above is untouched.
--
-- A rate agreed with a vendor is commercial terms. Without this, one company's negotiated rates
-- would be readable by every other tenant in the database.
ALTER TABLE "inventory"."VendorItemRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."VendorItemRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."VendorItemRate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
