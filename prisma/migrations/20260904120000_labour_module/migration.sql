-- Labour Management (feature 013): the `labour` schema (9 tables), one `settings`
-- reference master (SkillCategory), the LABOUR_APPROVE permission, the labour audit
-- entity types, and two Company settings (labour wage cycle, cash denominations).
--
-- Supersedes feature 005's Daily Worker registry (US9, FR-023 to FR-028), which was
-- never implemented — so there is no data migration, only fresh tables.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "labour";

-- CreateEnum
CREATE TYPE "settings"."LabourWageCycle" AS ENUM ('weekly', 'fortnightly', 'monthly');

-- CreateEnum
CREATE TYPE "labour"."EngagementType" AS ENUM ('direct', 'contractor');

-- CreateEnum
CREATE TYPE "labour"."WorkerStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "labour"."MusterSource" AS ENUM ('mobile', 'admin_entry');

-- CreateEnum
CREATE TYPE "labour"."MusterStatus" AS ENUM ('draft', 'submitted', 'approved');

-- CreateEnum
CREATE TYPE "labour"."AttendanceType" AS ENUM ('full_day', 'half_day', 'absent', 'overtime_only');

-- CreateEnum
CREATE TYPE "labour"."RateSource" AS ENUM ('override', 'project_rate');

-- CreateEnum
CREATE TYPE "labour"."PaymentSheetStatus" AS ENUM ('draft', 'approved', 'partially_disbursed', 'closed');

-- CreateEnum
CREATE TYPE "labour"."LabourPaymentMode" AS ENUM ('cash', 'bank');

-- CreateEnum
CREATE TYPE "labour"."PaymentSheetLineStatus" AS ENUM ('pending', 'disbursed', 'reversed');

-- CreateEnum
CREATE TYPE "labour"."AdvanceStatus" AS ENUM ('pending', 'approved', 'disbursed', 'closed');

-- AlterEnum
ALTER TYPE "settings"."Permission" ADD VALUE 'LABOUR_APPROVE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SKILL_CATEGORY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'WAGE_RATE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LABOUR_WORKER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LABOUR_GANG';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'MUSTER_ROLL';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LABOUR_PAYMENT_SHEET';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LABOUR_ADVANCE';

-- AlterTable
ALTER TABLE "settings"."Company"
  ADD COLUMN "labourWageCycle" "settings"."LabourWageCycle" NOT NULL DEFAULT 'weekly',
  ADD COLUMN "labourCashDenominations" INTEGER[] DEFAULT ARRAY[500, 200, 100, 50, 20, 10, 5, 1];

-- CreateTable
CREATE TABLE "settings"."SkillCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "defaultDailyRate" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."WageRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "skillCategoryId" TEXT NOT NULL,
    "dailyRate" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "WageRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourWorker" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "labourCode" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "aadhaarNumber" TEXT,
    "bankAccount" TEXT,
    "skillCategoryId" TEXT NOT NULL,
    "engagementType" "labour"."EngagementType" NOT NULL,
    "contractorId" TEXT,
    "siteId" TEXT NOT NULL,
    "rateOverride" DECIMAL(12,2),
    "faceEnrolmentId" TEXT,
    "status" "labour"."WorkerStatus" NOT NULL DEFAULT 'active',
    "lastWorkingDate" DATE,
    "deactivationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "LabourWorker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourGang" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gangLeaderWorkerId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "LabourGang_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."GangMember" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gangId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GangMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."MusterRoll" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "accuracyMetres" DECIMAL(8,2) NOT NULL,
    "geofenceViolation" BOOLEAN NOT NULL DEFAULT false,
    "lowGpsAccuracy" BOOLEAN NOT NULL DEFAULT false,
    "distanceFromFenceMetres" DECIMAL(10,2),
    "source" "labour"."MusterSource" NOT NULL DEFAULT 'mobile',
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isOfflineSynced" BOOLEAN NOT NULL DEFAULT false,
    "status" "labour"."MusterStatus" NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "returnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "MusterRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."MusterLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "musterId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "attendanceType" "labour"."AttendanceType" NOT NULL,
    "overtimeHours" DECIMAL(5,2),
    "photoRef" TEXT,
    "faceMatchScore" DECIMAL(6,4),
    "faceMatchLow" BOOLEAN NOT NULL DEFAULT false,
    "skillCategoryIdOnDay" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusterLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourPaymentSheet" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "engagementType" "labour"."EngagementType" NOT NULL,
    "status" "labour"."PaymentSheetStatus" NOT NULL DEFAULT 'draft',
    "grossTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductionTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "denominationBreakup" JSONB,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reopenReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "LabourPaymentSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."PaymentSheetLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "daysWorked" DECIMAL(6,2) NOT NULL,
    "overtimeHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "resolvedRate" DECIMAL(12,2) NOT NULL,
    "rateSource" "labour"."RateSource" NOT NULL,
    "grossWage" DECIMAL(14,2) NOT NULL,
    "deductions" JSONB NOT NULL,
    "netPayable" DECIMAL(14,2) NOT NULL,
    "paymentMode" "labour"."LabourPaymentMode",
    "paidOn" DATE,
    "paidAmount" DECIMAL(14,2),
    "shortPaymentReason" TEXT,
    "acknowledgementRef" TEXT,
    "carriedForwardBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "labour"."PaymentSheetLineStatus" NOT NULL DEFAULT 'pending',
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSheetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourAdvance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "recoveryInstalments" INTEGER NOT NULL,
    "instalmentAmount" DECIMAL(14,2) NOT NULL,
    "recoveryStartPeriod" DATE NOT NULL,
    "outstandingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exceedsLimit" BOOLEAN NOT NULL DEFAULT false,
    "status" "labour"."AdvanceStatus" NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "disbursedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "LabourAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillCategory_companyId_name_key" ON "settings"."SkillCategory"("companyId", "name");
CREATE UNIQUE INDEX "SkillCategory_companyId_code_key" ON "settings"."SkillCategory"("companyId", "code");
CREATE INDEX "SkillCategory_companyId_idx" ON "settings"."SkillCategory"("companyId");

-- CreateIndex
CREATE INDEX "WageRate_companyId_idx" ON "labour"."WageRate"("companyId");
CREATE INDEX "WageRate_companyId_projectId_skillCategoryId_effectiveFrom_idx" ON "labour"."WageRate"("companyId", "projectId", "skillCategoryId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "LabourWorker_companyId_labourCode_key" ON "labour"."LabourWorker"("companyId", "labourCode");
CREATE INDEX "LabourWorker_companyId_idx" ON "labour"."LabourWorker"("companyId");
CREATE INDEX "LabourWorker_companyId_siteId_idx" ON "labour"."LabourWorker"("companyId", "siteId");
CREATE INDEX "LabourWorker_companyId_skillCategoryId_idx" ON "labour"."LabourWorker"("companyId", "skillCategoryId");
CREATE INDEX "LabourWorker_companyId_status_idx" ON "labour"."LabourWorker"("companyId", "status");

-- CreateIndex
CREATE INDEX "LabourGang_companyId_idx" ON "labour"."LabourGang"("companyId");
CREATE INDEX "LabourGang_companyId_siteId_idx" ON "labour"."LabourGang"("companyId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "GangMember_gangId_workerId_key" ON "labour"."GangMember"("gangId", "workerId");
CREATE INDEX "GangMember_companyId_idx" ON "labour"."GangMember"("companyId");
CREATE INDEX "GangMember_workerId_idx" ON "labour"."GangMember"("workerId");
-- A worker belongs to at most one active gang at a time (FR-012): partial unique index.
CREATE UNIQUE INDEX "GangMember_workerId_active_key" ON "labour"."GangMember"("workerId") WHERE "isActive";

-- CreateIndex
CREATE INDEX "MusterRoll_companyId_idx" ON "labour"."MusterRoll"("companyId");
CREATE INDEX "MusterRoll_companyId_siteId_date_idx" ON "labour"."MusterRoll"("companyId", "siteId", "date");
CREATE INDEX "MusterRoll_companyId_status_idx" ON "labour"."MusterRoll"("companyId", "status");
-- One submitted/approved muster per site per date (FR-016): partial unique index.
CREATE UNIQUE INDEX "MusterRoll_siteId_date_active_key" ON "labour"."MusterRoll"("siteId", "date") WHERE "status" IN ('submitted', 'approved');

-- CreateIndex
CREATE UNIQUE INDEX "MusterLine_musterId_workerId_key" ON "labour"."MusterLine"("musterId", "workerId");
CREATE INDEX "MusterLine_companyId_idx" ON "labour"."MusterLine"("companyId");
CREATE INDEX "MusterLine_workerId_idx" ON "labour"."MusterLine"("workerId");

-- CreateIndex
CREATE INDEX "LabourPaymentSheet_companyId_idx" ON "labour"."LabourPaymentSheet"("companyId");
CREATE INDEX "LabourPaymentSheet_companyId_projectId_engagementType_idx" ON "labour"."LabourPaymentSheet"("companyId", "projectId", "engagementType");
CREATE INDEX "LabourPaymentSheet_companyId_status_idx" ON "labour"."LabourPaymentSheet"("companyId", "status");

-- CreateIndex
CREATE INDEX "PaymentSheetLine_companyId_idx" ON "labour"."PaymentSheetLine"("companyId");
CREATE INDEX "PaymentSheetLine_sheetId_idx" ON "labour"."PaymentSheetLine"("sheetId");
CREATE INDEX "PaymentSheetLine_workerId_idx" ON "labour"."PaymentSheetLine"("workerId");

-- CreateIndex
CREATE INDEX "LabourAdvance_companyId_idx" ON "labour"."LabourAdvance"("companyId");
CREATE INDEX "LabourAdvance_companyId_workerId_idx" ON "labour"."LabourAdvance"("companyId", "workerId");
CREATE INDEX "LabourAdvance_companyId_status_idx" ON "labour"."LabourAdvance"("companyId", "status");

-- AddForeignKey
ALTER TABLE "settings"."SkillCategory" ADD CONSTRAINT "SkillCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour"."GangMember" ADD CONSTRAINT "GangMember_gangId_fkey" FOREIGN KEY ("gangId") REFERENCES "labour"."LabourGang"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour"."GangMember" ADD CONSTRAINT "GangMember_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "labour"."LabourWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour"."MusterLine" ADD CONSTRAINT "MusterLine_musterId_fkey" FOREIGN KEY ("musterId") REFERENCES "labour"."MusterRoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour"."PaymentSheetLine" ADD CONSTRAINT "PaymentSheetLine_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "labour"."LabourPaymentSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
