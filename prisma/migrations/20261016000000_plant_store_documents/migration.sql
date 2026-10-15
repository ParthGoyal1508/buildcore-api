-- Plant and store documents in the client's formats (2026-10-15): the vehicle log book and diesel
-- report, the vehicle register, the work/hire order, the vehicle hiring bill, the daily issue
-- register, the maintenance job card, and the indent / delivery challan / GRN / issue slip /
-- transfer slip set. Every column added here is optional, so rows recorded before it read as they
-- always did.

-- CreateEnum
CREATE TYPE "plant"."HireBillBasis" AS ENUM ('hours', 'monthly');

-- CreateEnum
CREATE TYPE "plant"."RegistrationKind" AS ENUM ('rc', 'insurance', 'fitness', 'road_tax', 'permit', 'pollution');

-- CreateEnum
CREATE TYPE "plant"."RegistrationStatus" AS ENUM ('held', 'not_applicable', 'lifetime');

-- AlterEnum
ALTER TYPE "plant"."EquipmentOwnership" ADD VALUE 'leased';

-- AlterEnum


ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'JOB_CARD';
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'ISSUE_SLIP';
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'DELIVERY_CHALLAN';
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'STOCK_TRANSFER';

-- AlterTable
ALTER TABLE "inventory"."GoodsReceiptNote" ADD COLUMN     "acceptedQuantity" DECIMAL(18,3),
ADD COLUMN     "batchDetails" TEXT,
ADD COLUMN     "challanNo" TEXT,
ADD COLUMN     "condition" TEXT,
ADD COLUMN     "discrepancy" TEXT,
ADD COLUMN     "receivedQuantity" DECIMAL(18,3),
ADD COLUMN     "rejectedQuantity" DECIMAL(18,3),
ADD COLUMN     "vehicleNo" TEXT;

-- AlterTable
ALTER TABLE "inventory"."Issue" ADD COLUMN     "equipmentId" TEXT,
ADD COLUMN     "receivedBy" TEXT,
ADD COLUMN     "returnedOn" DATE,
ADD COLUMN     "returnedQuantity" DECIMAL(18,3),
ADD COLUMN     "slipNo" TEXT;

-- AlterTable
ALTER TABLE "inventory"."MaterialIndent" ADD COLUMN     "department" TEXT;

-- AlterTable
ALTER TABLE "inventory"."StockTransfer" ADD COLUMN     "challanNo" TEXT,
ADD COLUMN     "dispatchReference" TEXT,
ADD COLUMN     "expectedArrival" DATE,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "receivedQuantity" DECIMAL(18,3),
ADD COLUMN     "requestNo" TEXT,
ADD COLUMN     "transferNo" TEXT,
ADD COLUMN     "transporter" TEXT,
ADD COLUMN     "vehicleNo" TEXT;

-- AlterTable
ALTER TABLE "plant"."Equipment" ADD COLUMN     "chassisNo" TEXT,
ADD COLUMN     "engineNo" TEXT,
ADD COLUMN     "lastServiceDate" DATE,
ADD COLUMN     "make" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "operatorName" TEXT,
ADD COLUMN     "registeredOwner" TEXT,
ADD COLUMN     "registrationNo" TEXT,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "supplierName" TEXT;

-- AlterTable
ALTER TABLE "plant"."FuelEntry" ADD COLUMN     "cardNo" TEXT;

-- AlterTable
ALTER TABLE "plant"."HireBill" ADD COLUMN     "actualDiesel" DECIMAL(18,3),
ADD COLUMN     "agreedAverage" DECIMAL(10,3),
ADD COLUMN     "basis" "plant"."HireBillBasis" NOT NULL DEFAULT 'hours',
ADD COLUMN     "billDate" DATE,
ADD COLUMN     "deductionAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "dieselGiven" DECIMAL(18,3),
ADD COLUMN     "endReading" DECIMAL(18,3),
ADD COLUMN     "hireOrderId" TEXT,
ADD COLUMN     "holdAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "invoiceNo" TEXT,
ADD COLUMN     "monthlyRate" DECIMAL(18,2),
ADD COLUMN     "periodDays" INTEGER,
ADD COLUMN     "startReading" DECIMAL(18,3),
ADD COLUMN     "taxInvoiceDate" DATE,
ADD COLUMN     "taxInvoiceRef" TEXT;

-- AlterTable
ALTER TABLE "plant"."MaintenanceJob" ADD COLUMN     "card" JSONB,
ADD COLUMN     "jobCardNo" TEXT;

-- AlterTable
ALTER TABLE "settings"."EquipmentCategory" ADD COLUMN     "group" TEXT;

-- CreateTable
CREATE TABLE "plant"."EquipmentRegistrationItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "kind" "plant"."RegistrationKind" NOT NULL,
    "status" "plant"."RegistrationStatus" NOT NULL DEFAULT 'held',
    "expiresAt" DATE,
    "number" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentRegistrationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."HireOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "referenceNo" TEXT,
    "date" DATE NOT NULL,
    "vendorId" TEXT NOT NULL,
    "projectId" TEXT,
    "pointOfDelivery" TEXT,
    "remarks" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HireOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."HireOrderLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hireOrderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "equipmentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sacCode" TEXT,
    "taxRate" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(18,3) NOT NULL,
    "uom" TEXT NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "HireOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentRegistrationItem_companyId_idx" ON "plant"."EquipmentRegistrationItem"("companyId");

-- CreateIndex
CREATE INDEX "EquipmentRegistrationItem_companyId_expiresAt_idx" ON "plant"."EquipmentRegistrationItem"("companyId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRegistrationItem_equipmentId_kind_key" ON "plant"."EquipmentRegistrationItem"("equipmentId", "kind");

-- CreateIndex
CREATE INDEX "HireOrder_companyId_idx" ON "plant"."HireOrder"("companyId");

-- CreateIndex
CREATE INDEX "HireOrder_companyId_vendorId_idx" ON "plant"."HireOrder"("companyId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "HireOrder_companyId_code_key" ON "plant"."HireOrder"("companyId", "code");

-- CreateIndex
CREATE INDEX "HireOrderLine_hireOrderId_idx" ON "plant"."HireOrderLine"("hireOrderId");

-- CreateIndex
CREATE INDEX "HireOrderLine_companyId_idx" ON "plant"."HireOrderLine"("companyId");

-- AddForeignKey
ALTER TABLE "plant"."EquipmentRegistrationItem" ADD CONSTRAINT "EquipmentRegistrationItem_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."HireOrderLine" ADD CONSTRAINT "HireOrderLine_hireOrderId_fkey" FOREIGN KEY ("hireOrderId") REFERENCES "plant"."HireOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."HireOrderLine" ADD CONSTRAINT "HireOrderLine_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."HireBill" ADD CONSTRAINT "HireBill_hireOrderId_fkey" FOREIGN KEY ("hireOrderId") REFERENCES "plant"."HireOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-level security for the three new tables, as every tenant table has.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['EquipmentRegistrationItem', 'HireOrder', 'HireOrderLine'] LOOP
    EXECUTE format('ALTER TABLE "plant".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE "plant".%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "tenant_isolation" ON "plant".%I
      USING (
        current_setting('app.is_super_admin', true) = 'true'
        OR "companyId" = current_setting('app.current_company_id', true)
      )
      WITH CHECK (
        current_setting('app.is_super_admin', true) = 'true'
        OR "companyId" = current_setting('app.current_company_id', true)
      )$p$, t);
  END LOOP;
END $$;

-- The register's road-tax "Doc" column reads uploads of a ROAD TAX document type, which the
-- built-in list lacked. Added for every company that does not have one already.
INSERT INTO "settings"."EquipmentDocType" ("id", "companyId", "name", "alertDays", "active", "createdAt", "updatedAt")
SELECT 'edt_rt_' || c."id", c."id", 'ROAD TAX', 30, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "settings"."Company" c
ON CONFLICT DO NOTHING;
