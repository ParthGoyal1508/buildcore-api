-- Project Assets (feature 012): the `assets` schema (8 tables), three `settings`
-- reference masters (AssetCategory, AssetDocType, ConditionGrade — spec FR-002), the
-- ASSETS / ASSETS_APPROVE permissions, two code series, and the asset audit entity
-- types.
--
-- Fills the gap between 009 (consumables, tracked by running balance and consumed on
-- issue) and 006 (heavy equipment, tracked by logbook, fuel and hire bill): durable
-- items that are allocated to a project or a person and come back.
--
-- Structure-only, deliberately. The enum values added below cannot be *used* in the
-- same transaction that adds them — Postgres refuses an unsafe use of a new enum
-- value until the ALTER TYPE has committed — so the role grants and the masters
-- backfill that reference them live in 20260904200002, exactly as 006 split
-- 20260904081329 from 20260904081331 for the same reason.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "assets";

-- CreateEnum
CREATE TYPE "settings"."AssetTrackingMode" AS ENUM ('serialised', 'bulk');

-- CreateEnum
CREATE TYPE "assets"."AssetStatus" AS ENUM ('not_in_service', 'idle', 'allocated', 'in_transit', 'under_repair', 'scrapped');

-- CreateEnum
CREATE TYPE "assets"."AssetAllocationStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "assets"."AssetTransferStatus" AS ENUM ('in_transit', 'closed', 'closed_with_shortage', 'cancelled');

-- CreateEnum
CREATE TYPE "assets"."AssetRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'fulfilled', 'procurement_pending', 'cancelled');

-- CreateEnum
CREATE TYPE "assets"."AssetInspectionOutcome" AS ENUM ('pass', 'repair_required', 'condemn');

-- CreateEnum
CREATE TYPE "assets"."AssetRepairStatus" AS ENUM ('open', 'closed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'ASSETS';
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'ASSET_REQUEST';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "settings"."Permission" ADD VALUE 'ASSETS';
ALTER TYPE "settings"."Permission" ADD VALUE 'ASSETS_APPROVE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_ALLOCATION';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_TRANSFER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_REQUEST';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_INSPECTION';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_REPAIR';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_CATEGORY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ASSET_DOC_TYPE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CONDITION_GRADE';

-- CreateTable
CREATE TABLE "settings"."ConditionGrade" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "isDamaged" BOOLEAN NOT NULL DEFAULT false,
    "isScrap" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConditionGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."AssetCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trackingMode" "settings"."AssetTrackingMode" NOT NULL,
    "depreciationRatePercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "usefulLifeYears" INTEGER NOT NULL DEFAULT 5,
    "custodyRequired" BOOLEAN NOT NULL DEFAULT false,
    "inspectionRequired" BOOLEAN NOT NULL DEFAULT false,
    "inspectionIntervalDays" INTEGER,
    "repairCostThresholdPercent" DECIMAL(6,2) NOT NULL DEFAULT 50,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."AssetDocType" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "alertDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetDocType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."Asset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "trackingMode" "settings"."AssetTrackingMode" NOT NULL,
    "manufacturer" TEXT,
    "modelNumber" TEXT,
    "serialNumber" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "unitOfMeasure" TEXT,
    "purchaseDate" DATE,
    "purchaseCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "capitalisationDate" DATE NOT NULL,
    "depreciationRatePercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "usefulLifeYears" INTEGER NOT NULL DEFAULT 5,
    "salvageValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vendorId" TEXT,
    "purchaseId" TEXT,
    "currentSiteId" TEXT NOT NULL,
    "currentCustodianId" TEXT,
    "currentConditionGradeId" TEXT,
    "status" "assets"."AssetStatus" NOT NULL DEFAULT 'idle',
    "nextInspectionDue" DATE,
    "disposalDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetStock" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "quantityOnHand" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "quantityAllocated" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "quantityInTransit" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "custodianEmployeeId" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "allocatedFrom" DATE NOT NULL,
    "expectedReturnDate" DATE NOT NULL,
    "actualReturnDate" DATE,
    "conditionOnReturnId" TEXT,
    "remarks" TEXT,
    "status" "assets"."AssetAllocationStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "AssetAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromSiteId" TEXT NOT NULL,
    "toSiteId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "dispatchDate" DATE NOT NULL,
    "transportMode" TEXT,
    "vehicleNumber" TEXT,
    "dispatchConditionId" TEXT,
    "receivedDate" DATE,
    "receivedQuantity" DECIMAL(18,3),
    "conditionOnReceiptId" TEXT,
    "conditionDiscrepancy" BOOLEAN NOT NULL DEFAULT false,
    "transitShortage" DECIMAL(18,3),
    "status" "assets"."AssetTransferStatus" NOT NULL DEFAULT 'in_transit',
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "AssetTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "assetId" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "requiredByDate" DATE NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "assets"."AssetRequestStatus" NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "fulfilledAllocationId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "AssetRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetInspection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "inspectionDate" DATE NOT NULL,
    "conditionGradeId" TEXT NOT NULL,
    "outcome" "assets"."AssetInspectionOutcome" NOT NULL,
    "remarks" TEXT,
    "inspectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetRepair" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "repairDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vendorId" TEXT,
    "expectedCompletionDate" DATE,
    "actualCompletionDate" DATE,
    "resultingConditionGradeId" TEXT,
    "downtimeDays" INTEGER,
    "status" "assets"."AssetRepairStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AssetRepair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets"."AssetDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "docTypeId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "documentNumber" TEXT,
    "issueDate" DATE,
    "expiryDate" DATE,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConditionGrade_companyId_idx" ON "settings"."ConditionGrade"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ConditionGrade_companyId_name_key" ON "settings"."ConditionGrade"("companyId", "name");

-- CreateIndex
CREATE INDEX "AssetCategory_companyId_idx" ON "settings"."AssetCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCategory_companyId_name_key" ON "settings"."AssetCategory"("companyId", "name");

-- CreateIndex
CREATE INDEX "AssetDocType_companyId_idx" ON "settings"."AssetDocType"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDocType_companyId_name_key" ON "settings"."AssetDocType"("companyId", "name");

-- CreateIndex
CREATE INDEX "Asset_companyId_idx" ON "assets"."Asset"("companyId");

-- CreateIndex
CREATE INDEX "Asset_companyId_categoryId_idx" ON "assets"."Asset"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "Asset_companyId_currentSiteId_idx" ON "assets"."Asset"("companyId", "currentSiteId");

-- CreateIndex
CREATE INDEX "Asset_companyId_status_idx" ON "assets"."Asset"("companyId", "status");

-- CreateIndex
CREATE INDEX "Asset_companyId_currentCustodianId_idx" ON "assets"."Asset"("companyId", "currentCustodianId");

-- CreateIndex
CREATE INDEX "Asset_companyId_nextInspectionDue_idx" ON "assets"."Asset"("companyId", "nextInspectionDue");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_companyId_assetCode_key" ON "assets"."Asset"("companyId", "assetCode");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_companyId_serialNumber_key" ON "assets"."Asset"("companyId", "serialNumber");

-- CreateIndex
CREATE INDEX "AssetStock_companyId_idx" ON "assets"."AssetStock"("companyId");

-- CreateIndex
CREATE INDEX "AssetStock_companyId_siteId_idx" ON "assets"."AssetStock"("companyId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetStock_assetId_siteId_key" ON "assets"."AssetStock"("assetId", "siteId");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_idx" ON "assets"."AssetAllocation"("companyId");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_assetId_idx" ON "assets"."AssetAllocation"("companyId", "assetId");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_projectId_idx" ON "assets"."AssetAllocation"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_siteId_idx" ON "assets"."AssetAllocation"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_status_idx" ON "assets"."AssetAllocation"("companyId", "status");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_custodianEmployeeId_idx" ON "assets"."AssetAllocation"("companyId", "custodianEmployeeId");

-- CreateIndex
CREATE INDEX "AssetAllocation_companyId_expectedReturnDate_idx" ON "assets"."AssetAllocation"("companyId", "expectedReturnDate");

-- CreateIndex
CREATE INDEX "AssetTransfer_companyId_idx" ON "assets"."AssetTransfer"("companyId");

-- CreateIndex
CREATE INDEX "AssetTransfer_companyId_assetId_idx" ON "assets"."AssetTransfer"("companyId", "assetId");

-- CreateIndex
CREATE INDEX "AssetTransfer_companyId_status_idx" ON "assets"."AssetTransfer"("companyId", "status");

-- CreateIndex
CREATE INDEX "AssetTransfer_companyId_toSiteId_idx" ON "assets"."AssetTransfer"("companyId", "toSiteId");

-- CreateIndex
CREATE INDEX "AssetTransfer_companyId_dispatchDate_idx" ON "assets"."AssetTransfer"("companyId", "dispatchDate");

-- CreateIndex
CREATE INDEX "AssetRequest_companyId_idx" ON "assets"."AssetRequest"("companyId");

-- CreateIndex
CREATE INDEX "AssetRequest_companyId_status_idx" ON "assets"."AssetRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "AssetRequest_companyId_projectId_idx" ON "assets"."AssetRequest"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "AssetRequest_companyId_siteId_idx" ON "assets"."AssetRequest"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "AssetRequest_companyId_requiredByDate_idx" ON "assets"."AssetRequest"("companyId", "requiredByDate");

-- CreateIndex
CREATE UNIQUE INDEX "AssetRequest_companyId_requestNumber_key" ON "assets"."AssetRequest"("companyId", "requestNumber");

-- CreateIndex
CREATE INDEX "AssetInspection_companyId_idx" ON "assets"."AssetInspection"("companyId");

-- CreateIndex
CREATE INDEX "AssetInspection_companyId_assetId_idx" ON "assets"."AssetInspection"("companyId", "assetId");

-- CreateIndex
CREATE INDEX "AssetInspection_companyId_inspectionDate_idx" ON "assets"."AssetInspection"("companyId", "inspectionDate");

-- CreateIndex
CREATE INDEX "AssetRepair_companyId_idx" ON "assets"."AssetRepair"("companyId");

-- CreateIndex
CREATE INDEX "AssetRepair_companyId_assetId_idx" ON "assets"."AssetRepair"("companyId", "assetId");

-- CreateIndex
CREATE INDEX "AssetRepair_companyId_status_idx" ON "assets"."AssetRepair"("companyId", "status");

-- CreateIndex
CREATE INDEX "AssetDocument_companyId_idx" ON "assets"."AssetDocument"("companyId");

-- CreateIndex
CREATE INDEX "AssetDocument_assetId_idx" ON "assets"."AssetDocument"("assetId");

-- CreateIndex
CREATE INDEX "AssetDocument_companyId_expiryDate_idx" ON "assets"."AssetDocument"("companyId", "expiryDate");

-- AddForeignKey
ALTER TABLE "settings"."ConditionGrade" ADD CONSTRAINT "ConditionGrade_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."AssetCategory" ADD CONSTRAINT "AssetCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."AssetDocType" ADD CONSTRAINT "AssetDocType_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets"."AssetStock" ADD CONSTRAINT "AssetStock_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets"."AssetAllocation" ADD CONSTRAINT "AssetAllocation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets"."AssetTransfer" ADD CONSTRAINT "AssetTransfer_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets"."AssetInspection" ADD CONSTRAINT "AssetInspection_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets"."AssetRepair" ADD CONSTRAINT "AssetRepair_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets"."AssetDocument" ADD CONSTRAINT "AssetDocument_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

