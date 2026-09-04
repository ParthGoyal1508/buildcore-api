-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "plant";

-- CreateEnum
CREATE TYPE "settings"."MeterType" AS ENUM ('hours', 'km');

-- CreateEnum
CREATE TYPE "plant"."EquipmentOwnership" AS ENUM ('owned', 'hired');

-- CreateEnum
CREATE TYPE "plant"."PowerSource" AS ENUM ('diesel', 'petrol', 'electric', 'manual');

-- CreateEnum
CREATE TYPE "plant"."EquipmentStatus" AS ENUM ('active', 'under_maintenance', 'inactive');

-- CreateEnum
CREATE TYPE "plant"."MaintenanceType" AS ENUM ('breakdown', 'scheduled');

-- CreateEnum
CREATE TYPE "plant"."MaintenanceStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "plant"."HireBillStatus" AS ENUM ('pending_verification', 'verified', 'paid');

-- CreateEnum
CREATE TYPE "plant"."SparePartMovementType" AS ENUM ('receipt', 'consumption', 'reversal');

-- CreateEnum
CREATE TYPE "plant"."ServiceBillStatus" AS ENUM ('pending_verification', 'verified');

-- CreateEnum
CREATE TYPE "plant"."ServiceBillPaymentStatus" AS ENUM ('unpaid', 'partially_paid', 'paid');

-- AlterEnum
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'EQUIPMENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "settings"."Permission" ADD VALUE 'MAINTENANCE';
ALTER TYPE "settings"."Permission" ADD VALUE 'HIRE_BILLS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EQUIPMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EQUIPMENT_DOCUMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LOGBOOK_ENTRY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'FUEL_ENTRY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SERVICE_SCHEDULE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'MAINTENANCE_JOB';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'HIRE_BILL';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EQUIPMENT_CATEGORY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EQUIPMENT_DOC_TYPE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'HIRE_RATE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SPARE_PART';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SPARE_PART_MOVEMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SERVICE_BILL';

-- CreateTable
CREATE TABLE "settings"."EquipmentCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "meterType" "settings"."MeterType" NOT NULL,
    "fuelBenchmark" DECIMAL(18,3),
    "fuelVarianceThresholdPercent" DECIMAL(6,2) NOT NULL DEFAULT 15,
    "targetHoursPerMonth" INTEGER NOT NULL DEFAULT 176,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."EquipmentDocType" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "alertDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentDocType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."HireRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "ratePerUnit" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HireRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."Equipment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "ownership" "plant"."EquipmentOwnership" NOT NULL,
    "vendorId" TEXT,
    "powerSource" "plant"."PowerSource" NOT NULL,
    "purchaseDate" DATE,
    "purchaseCost" DECIMAL(18,2),
    "depreciationRate" DECIMAL(6,2),
    "meterType" "settings"."MeterType" NOT NULL,
    "currentReading" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "deployedSiteId" TEXT,
    "status" "plant"."EquipmentStatus" NOT NULL DEFAULT 'active',
    "utilizationPercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."EquipmentDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "docTypeId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "expiresAt" DATE,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."LogbookEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "openingReading" DECIMAL(18,3) NOT NULL,
    "closingReading" DECIMAL(18,3) NOT NULL,
    "totalHours" DECIMAL(18,3) NOT NULL,
    "fuelConsumed" DECIMAL(18,3),
    "operatorId" TEXT,
    "projectId" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogbookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."FuelEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "vendorId" TEXT,
    "variancePercent" DECIMAL(8,2),
    "varianceAlert" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FuelEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."ServiceSchedule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "intervalHours" DECIMAL(18,3),
    "intervalKm" DECIMAL(18,3),
    "lastDoneReading" DECIMAL(18,3) NOT NULL,
    "nextDueReading" DECIMAL(18,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."MaintenanceJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "type" "plant"."MaintenanceType" NOT NULL,
    "description" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closingReading" DECIMAL(18,3),
    "partsDescription" TEXT,
    "labourCost" DECIMAL(18,2),
    "partsCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,2),
    "linkedServiceScheduleId" TEXT,
    "status" "plant"."MaintenanceStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."HireBill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "billedHours" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "billingPeriodFrom" DATE NOT NULL,
    "billingPeriodTo" DATE NOT NULL,
    "logbookHours" DECIMAL(18,3) NOT NULL,
    "variance" DECIMAL(18,3) NOT NULL,
    "tdsRate" DECIMAL(6,2),
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL,
    "status" "plant"."HireBillStatus" NOT NULL DEFAULT 'pending_verification',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "paymentDate" DATE,
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HireBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."SparePart" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitOfMeasure" TEXT NOT NULL,
    "reorderLevel" DECIMAL(18,3),
    "compatibleCategoryIds" TEXT[],
    "linkedInventoryItemId" TEXT,
    "stockQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "avgRate" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SparePart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."SparePartMovement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sparePartId" TEXT NOT NULL,
    "type" "plant"."SparePartMovementType" NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "movementDate" DATE NOT NULL,
    "maintenanceJobId" TEXT,
    "vendorId" TEXT,
    "billReference" TEXT,
    "incompatiblePart" BOOLEAN NOT NULL DEFAULT false,
    "reversalOfId" TEXT,
    "reason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SparePartMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."ServiceBill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "maintenanceJobId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "billDate" DATE NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsPercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(18,2) NOT NULL,
    "netPayable" DECIMAL(18,2) NOT NULL,
    "status" "plant"."ServiceBillStatus" NOT NULL DEFAULT 'pending_verification',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "paymentStatus" "plant"."ServiceBillPaymentStatus" NOT NULL DEFAULT 'unpaid',
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidOn" DATE,
    "paymentReference" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentCategory_companyId_idx" ON "settings"."EquipmentCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentCategory_companyId_name_key" ON "settings"."EquipmentCategory"("companyId", "name");

-- CreateIndex
CREATE INDEX "EquipmentDocType_companyId_idx" ON "settings"."EquipmentDocType"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentDocType_companyId_name_key" ON "settings"."EquipmentDocType"("companyId", "name");

-- CreateIndex
CREATE INDEX "HireRate_companyId_idx" ON "settings"."HireRate"("companyId");

-- CreateIndex
CREATE INDEX "HireRate_companyId_categoryId_effectiveFrom_idx" ON "settings"."HireRate"("companyId", "categoryId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "Equipment_companyId_idx" ON "plant"."Equipment"("companyId");

-- CreateIndex
CREATE INDEX "Equipment_companyId_categoryId_idx" ON "plant"."Equipment"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "Equipment_companyId_deployedSiteId_idx" ON "plant"."Equipment"("companyId", "deployedSiteId");

-- CreateIndex
CREATE INDEX "Equipment_companyId_status_idx" ON "plant"."Equipment"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_companyId_code_key" ON "plant"."Equipment"("companyId", "code");

-- CreateIndex
CREATE INDEX "EquipmentDocument_companyId_idx" ON "plant"."EquipmentDocument"("companyId");

-- CreateIndex
CREATE INDEX "EquipmentDocument_equipmentId_idx" ON "plant"."EquipmentDocument"("equipmentId");

-- CreateIndex
CREATE INDEX "LogbookEntry_companyId_date_idx" ON "plant"."LogbookEntry"("companyId", "date");

-- CreateIndex
CREATE INDEX "LogbookEntry_companyId_equipmentId_date_idx" ON "plant"."LogbookEntry"("companyId", "equipmentId", "date");

-- CreateIndex
CREATE INDEX "LogbookEntry_companyId_projectId_idx" ON "plant"."LogbookEntry"("companyId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "LogbookEntry_equipmentId_date_key" ON "plant"."LogbookEntry"("equipmentId", "date");

-- CreateIndex
CREATE INDEX "FuelEntry_companyId_date_idx" ON "plant"."FuelEntry"("companyId", "date");

-- CreateIndex
CREATE INDEX "FuelEntry_companyId_equipmentId_date_idx" ON "plant"."FuelEntry"("companyId", "equipmentId", "date");

-- CreateIndex
CREATE INDEX "ServiceSchedule_companyId_idx" ON "plant"."ServiceSchedule"("companyId");

-- CreateIndex
CREATE INDEX "ServiceSchedule_companyId_equipmentId_idx" ON "plant"."ServiceSchedule"("companyId", "equipmentId");

-- CreateIndex
CREATE INDEX "MaintenanceJob_companyId_status_idx" ON "plant"."MaintenanceJob"("companyId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceJob_companyId_equipmentId_status_idx" ON "plant"."MaintenanceJob"("companyId", "equipmentId", "status");

-- CreateIndex
CREATE INDEX "HireBill_companyId_status_idx" ON "plant"."HireBill"("companyId", "status");

-- CreateIndex
CREATE INDEX "HireBill_companyId_equipmentId_idx" ON "plant"."HireBill"("companyId", "equipmentId");

-- CreateIndex
CREATE INDEX "HireBill_companyId_vendorId_idx" ON "plant"."HireBill"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "SparePart_companyId_idx" ON "plant"."SparePart"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SparePart_companyId_partNumber_key" ON "plant"."SparePart"("companyId", "partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SparePartMovement_reversalOfId_key" ON "plant"."SparePartMovement"("reversalOfId");

-- CreateIndex
CREATE INDEX "SparePartMovement_companyId_sparePartId_idx" ON "plant"."SparePartMovement"("companyId", "sparePartId");

-- CreateIndex
CREATE INDEX "SparePartMovement_companyId_maintenanceJobId_idx" ON "plant"."SparePartMovement"("companyId", "maintenanceJobId");

-- CreateIndex
CREATE INDEX "ServiceBill_companyId_maintenanceJobId_idx" ON "plant"."ServiceBill"("companyId", "maintenanceJobId");

-- CreateIndex
CREATE INDEX "ServiceBill_companyId_vendorId_idx" ON "plant"."ServiceBill"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "ServiceBill_companyId_paymentStatus_idx" ON "plant"."ServiceBill"("companyId", "paymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBill_companyId_vendorId_billNumber_key" ON "plant"."ServiceBill"("companyId", "vendorId", "billNumber");

-- AddForeignKey
ALTER TABLE "settings"."EquipmentCategory" ADD CONSTRAINT "EquipmentCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."EquipmentDocType" ADD CONSTRAINT "EquipmentDocType_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."HireRate" ADD CONSTRAINT "HireRate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."HireRate" ADD CONSTRAINT "HireRate_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "settings"."EquipmentCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."EquipmentDocument" ADD CONSTRAINT "EquipmentDocument_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."LogbookEntry" ADD CONSTRAINT "LogbookEntry_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."FuelEntry" ADD CONSTRAINT "FuelEntry_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."ServiceSchedule" ADD CONSTRAINT "ServiceSchedule_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_linkedServiceScheduleId_fkey" FOREIGN KEY ("linkedServiceScheduleId") REFERENCES "plant"."ServiceSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."HireBill" ADD CONSTRAINT "HireBill_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."SparePartMovement" ADD CONSTRAINT "SparePartMovement_sparePartId_fkey" FOREIGN KEY ("sparePartId") REFERENCES "plant"."SparePart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."SparePartMovement" ADD CONSTRAINT "SparePartMovement_maintenanceJobId_fkey" FOREIGN KEY ("maintenanceJobId") REFERENCES "plant"."MaintenanceJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."SparePartMovement" ADD CONSTRAINT "SparePartMovement_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "plant"."SparePartMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."ServiceBill" ADD CONSTRAINT "ServiceBill_maintenanceJobId_fkey" FOREIGN KEY ("maintenanceJobId") REFERENCES "plant"."MaintenanceJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-authored: the FR-002 / research.md §2 guarantee ────────────────────
--
-- "At most one open maintenance job per equipment." Prisma has no syntax for a
-- partial unique index, so this is written out — the same exception 004's
-- `ReminderNotification_open_unique` and 008's `Client_companyId_gstin_key` take.
--
-- Scoped to `status = 'open'` because the constraint is about what is currently
-- being worked on, not about history: a machine legitimately has dozens of closed
-- jobs, and a total unique index would reject the second one ever raised.
--
-- This is the real guarantee. `MaintenanceService.create()` also checks first, so
-- the caller gets a 409 with a useful message rather than a constraint error; that
-- check races with a concurrent open, and losing the race must fail rather than
-- leave a machine with two open jobs and an ambiguous status.
CREATE UNIQUE INDEX "MaintenanceJob_open_unique"
  ON "plant"."MaintenanceJob"("equipmentId")
  WHERE "status" = 'open';
