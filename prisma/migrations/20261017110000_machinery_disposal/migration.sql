-- Machine disposal (2026-10-17): a machine is retired as scrapped or sold through a disposal record,
-- which an admin can reverse; every disposal and reversal is written to the machine's history.
--
-- The enum values added here are not used in this migration, so adding them in its transaction is
-- safe; the grant that uses MACHINERY_DISPOSE is in the next migration for that reason.

-- CreateEnum
CREATE TYPE "plant"."EquipmentDisposalType" AS ENUM ('scrapped', 'sold');

-- CreateEnum
CREATE TYPE "plant"."EquipmentScrapReason" AS ENUM ('damaged_beyond_repair', 'end_of_life', 'accident', 'obsolete', 'other');

-- AlterEnum
ALTER TYPE "settings"."Permission" ADD VALUE 'MACHINERY_DISPOSE';

-- AlterEnum
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EQUIPMENT_DISPOSAL';

-- AlterEnum


ALTER TYPE "plant"."EquipmentStatus" ADD VALUE 'scrapped';
ALTER TYPE "plant"."EquipmentStatus" ADD VALUE 'sold';

-- CreateTable
CREATE TABLE "plant"."EquipmentDisposal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "type" "plant"."EquipmentDisposalType" NOT NULL,
    "disposalDate" DATE NOT NULL,
    "scrapReason" "plant"."EquipmentScrapReason",
    "counterpartyName" TEXT,
    "buyerContact" TEXT,
    "paymentMode" TEXT,
    "invoiceNumber" TEXT,
    "valueRealised" DECIMAL(18,2),
    "bookValue" DECIMAL(18,2),
    "bookValueSource" TEXT,
    "profitLoss" DECIMAL(18,2),
    "approvedBy" TEXT NOT NULL,
    "remarks" TEXT,
    "attachmentRef" TEXT,
    "attachmentName" TEXT,
    "attachmentMime" TEXT,
    "previousStatus" "plant"."EquipmentStatus" NOT NULL,
    "releasedSiteId" TEXT,
    "projectId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "EquipmentDisposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."EquipmentEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentDisposal_companyId_idx" ON "plant"."EquipmentDisposal"("companyId");

-- CreateIndex
CREATE INDEX "EquipmentDisposal_companyId_type_disposalDate_idx" ON "plant"."EquipmentDisposal"("companyId", "type", "disposalDate");

-- CreateIndex
CREATE INDEX "EquipmentDisposal_equipmentId_idx" ON "plant"."EquipmentDisposal"("equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentEvent_companyId_idx" ON "plant"."EquipmentEvent"("companyId");

-- CreateIndex
CREATE INDEX "EquipmentEvent_equipmentId_createdAt_idx" ON "plant"."EquipmentEvent"("equipmentId", "createdAt");


-- One disposal in force per machine: a reversal frees the machine to be disposed again.
CREATE UNIQUE INDEX "EquipmentDisposal_one_in_force" ON "plant"."EquipmentDisposal"("equipmentId") WHERE "reversedAt" IS NULL;
