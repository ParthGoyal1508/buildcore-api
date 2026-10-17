-- 036 M9 (2026-10-17): purchase orders, structured behind the unchanged PO letter. See the
-- PurchaseOrder model's note in schema.prisma. Additive: a nullable link on Purchase and two new
-- tables, so every purchase recorded before this keeps working and simply has no PO line.
-- AlterTable
ALTER TABLE "inventory"."Purchase" ADD COLUMN     "purchaseOrderLineId" TEXT;

-- CreateTable
CREATE TABLE "inventory"."PurchaseOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "referenceNo" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "vendorId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "gstPercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "gstPercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_letterId_key" ON "inventory"."PurchaseOrder"("letterId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_idx" ON "inventory"."PurchaseOrder"("companyId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_vendorId_idx" ON "inventory"."PurchaseOrder"("companyId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_companyId_referenceNo_key" ON "inventory"."PurchaseOrder"("companyId", "referenceNo");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_companyId_idx" ON "inventory"."PurchaseOrderLine"("companyId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_companyId_itemId_idx" ON "inventory"."PurchaseOrderLine"("companyId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_purchaseOrderId_lineNo_key" ON "inventory"."PurchaseOrderLine"("purchaseOrderId", "lineNo");

-- CreateIndex
CREATE INDEX "Purchase_purchaseOrderLineId_idx" ON "inventory"."Purchase"("purchaseOrderLineId");

-- AddForeignKey
ALTER TABLE "inventory"."Purchase" ADD CONSTRAINT "Purchase_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "inventory"."PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "inventory"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Row-level security (Principle IV), appended as every table here gets it — see
-- `20261007110000_vendor_item_rate`. What a company ordered, from whom and at what rate is
-- commercial terms another tenant must not read.
ALTER TABLE "inventory"."PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."PurchaseOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."PurchaseOrder"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
ALTER TABLE "inventory"."PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."PurchaseOrderLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."PurchaseOrderLine"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
