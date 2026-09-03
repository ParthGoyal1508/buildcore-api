-- Feature 008, step 2 of 2: the eleven new `projects` tables, plus the foreign key
-- from the `Site.projectId` column added in the previous migration.
--
-- Enum values are appended to `settings.CodeSeriesType` and `shared.AuditEntityType`
-- rather than replacing them; none is *used* in this migration, which is what keeps
-- the ALTER TYPE legal inside Prisma's per-migration transaction on PostgreSQL.

-- CreateEnum
CREATE TYPE "projects"."ClientStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "projects"."ProjectStatus" AS ENUM ('planning', 'ongoing', 'on_hold', 'completed');

-- CreateEnum
CREATE TYPE "projects"."ProjectDivision" AS ENUM ('contract', 'own');

-- CreateEnum
CREATE TYPE "projects"."ProjectSiteType" AS ENUM ('site', 'toll', 'plant');

-- CreateEnum
CREATE TYPE "projects"."DwrWeather" AS ENUM ('clear', 'rainy', 'overcast');

-- CreateEnum
CREATE TYPE "projects"."DwrStatus" AS ENUM ('draft', 'submitted', 'approved');

-- CreateEnum
CREATE TYPE "projects"."DwrPaymentMode" AS ENUM ('work_basis', 'day_basis');

-- CreateEnum
CREATE TYPE "projects"."RevenueStatus" AS ENUM ('received', 'pending');

-- CreateEnum
CREATE TYPE "projects"."RaBillStatus" AS ENUM ('draft', 'submitted', 'approved');

-- CreateEnum
CREATE TYPE "projects"."WorkOrderStatus" AS ENUM ('draft', 'active', 'completed');

-- CreateEnum
CREATE TYPE "projects"."ProjectBudgetCategory" AS ENUM ('labour', 'materials', 'machinery', 'fuel', 'subcontractors', 'overheads');

-- AlterEnum
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'PROJECTS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PROJECT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CLIENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SITE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'BOQ_GROUP';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'BOQ_ITEM';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'DWR';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'REVENUE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'RA_BILL';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'WORK_ORDER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PROJECT_BUDGET';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PROJECT_DOCUMENT';

-- CreateTable
CREATE TABLE "projects"."Client" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "gstin" TEXT,
    "status" "projects"."ClientStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."Project" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "location" TEXT,
    "contractValue" DECIMAL(18,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "expectedEndDate" TIMESTAMP(3),
    "status" "projects"."ProjectStatus" NOT NULL DEFAULT 'planning',
    "projectManagerEmployeeId" TEXT,
    "division" "projects"."ProjectDivision" NOT NULL DEFAULT 'contract',
    "departmentType" TEXT,
    "projectType" TEXT,
    "siteType" "projects"."ProjectSiteType" NOT NULL DEFAULT 'site',
    "isHO" BOOLEAN NOT NULL DEFAULT false,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "siteStartDate" TIMESTAMP(3),
    "purchaseLimit" DECIMAL(18,2),
    "orderNumber" TEXT,
    "cgstApplicable" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BOQTaskGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "boqNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "finishDate" TIMESTAMP(3) NOT NULL,
    "scopeQty" DECIMAL(18,3) NOT NULL,
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BOQTaskGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BOQTaskItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "boqNo" TEXT NOT NULL,
    "taskName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "scopeQty" DECIMAL(18,3) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "finishDate" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "perDayQty" DECIMAL(18,3) NOT NULL,
    "doneQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BOQTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."DailyWorkReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "dprNumber" TEXT NOT NULL,
    "supervisorEmployeeId" TEXT,
    "weather" "projects"."DwrWeather" NOT NULL DEFAULT 'clear',
    "status" "projects"."DwrStatus" NOT NULL DEFAULT 'draft',
    "workerCount" INTEGER NOT NULL DEFAULT 0,
    "machineryCount" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "description" TEXT,
    "contractFor" TEXT NOT NULL DEFAULT 'self',
    "contractNumber" TEXT,
    "rfiNo" TEXT,
    "layer" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "fileRefs" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyWorkReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."DWRTask" (
    "id" TEXT NOT NULL,
    "dwrId" TEXT NOT NULL,
    "boqItemId" TEXT,
    "layer" TEXT,
    "chainageFrom" DECIMAL(18,3),
    "chainageTo" DECIMAL(18,3),
    "roadSide" TEXT,
    "paymentMode" "projects"."DwrPaymentMode" NOT NULL DEFAULT 'work_basis',
    "nos1" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "nos2" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "length" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "breadth" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "depth" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "density" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "actualQty" DECIMAL(18,3) NOT NULL,
    "exceedsScope" BOOLEAN NOT NULL DEFAULT false,
    "engineerName" TEXT,
    "remark" TEXT,
    "layerNo" TEXT,
    "section" TEXT,

    CONSTRAINT "DWRTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."Revenue" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "projects"."RevenueStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Revenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."RABill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "billingDate" TIMESTAMP(3) NOT NULL,
    "status" "projects"."RaBillStatus" NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionRemark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RABill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."WorkOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "partnerId" TEXT,
    "workDetail" TEXT NOT NULL,
    "terms" TEXT,
    "requirements" TEXT,
    "hireContract" TEXT,
    "labourAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "materialAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "projects"."WorkOrderStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."ProjectBudget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" "projects"."ProjectBudgetCategory" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."ProjectDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "filePath" TEXT,
    "remark" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Client_companyId_idx" ON "projects"."Client"("companyId");

-- CreateIndex
CREATE INDEX "Client_companyId_status_idx" ON "projects"."Client"("companyId", "status");

-- CreateIndex
CREATE INDEX "Project_companyId_idx" ON "projects"."Project"("companyId");

-- CreateIndex
CREATE INDEX "Project_companyId_status_idx" ON "projects"."Project"("companyId", "status");

-- CreateIndex
CREATE INDEX "Project_clientId_idx" ON "projects"."Project"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_companyId_code_key" ON "projects"."Project"("companyId", "code");

-- CreateIndex
CREATE INDEX "BOQTaskGroup_companyId_idx" ON "projects"."BOQTaskGroup"("companyId");

-- CreateIndex
CREATE INDEX "BOQTaskGroup_projectId_idx" ON "projects"."BOQTaskGroup"("projectId");

-- CreateIndex
CREATE INDEX "BOQTaskItem_companyId_idx" ON "projects"."BOQTaskItem"("companyId");

-- CreateIndex
CREATE INDEX "BOQTaskItem_groupId_idx" ON "projects"."BOQTaskItem"("groupId");

-- CreateIndex
CREATE INDEX "DailyWorkReport_companyId_idx" ON "projects"."DailyWorkReport"("companyId");

-- CreateIndex
CREATE INDEX "DailyWorkReport_projectId_workDate_idx" ON "projects"."DailyWorkReport"("projectId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyWorkReport_companyId_dprNumber_key" ON "projects"."DailyWorkReport"("companyId", "dprNumber");

-- CreateIndex
CREATE INDEX "DWRTask_dwrId_idx" ON "projects"."DWRTask"("dwrId");

-- CreateIndex
CREATE INDEX "DWRTask_boqItemId_idx" ON "projects"."DWRTask"("boqItemId");

-- CreateIndex
CREATE INDEX "Revenue_companyId_idx" ON "projects"."Revenue"("companyId");

-- CreateIndex
CREATE INDEX "Revenue_projectId_idx" ON "projects"."Revenue"("projectId");

-- CreateIndex
CREATE INDEX "RABill_companyId_idx" ON "projects"."RABill"("companyId");

-- CreateIndex
CREATE INDEX "RABill_projectId_idx" ON "projects"."RABill"("projectId");

-- CreateIndex
CREATE INDEX "WorkOrder_companyId_idx" ON "projects"."WorkOrder"("companyId");

-- CreateIndex
CREATE INDEX "WorkOrder_projectId_idx" ON "projects"."WorkOrder"("projectId");

-- CreateIndex
CREATE INDEX "ProjectBudget_companyId_idx" ON "projects"."ProjectBudget"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBudget_projectId_category_key" ON "projects"."ProjectBudget"("projectId", "category");

-- CreateIndex
CREATE INDEX "ProjectDocument_companyId_idx" ON "projects"."ProjectDocument"("companyId");

-- CreateIndex
CREATE INDEX "ProjectDocument_projectId_idx" ON "projects"."ProjectDocument"("projectId");

-- AddForeignKey
ALTER TABLE "projects"."Site" ADD CONSTRAINT "Site_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."Project" ADD CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "projects"."Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BOQTaskGroup" ADD CONSTRAINT "BOQTaskGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BOQTaskItem" ADD CONSTRAINT "BOQTaskItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "projects"."BOQTaskGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."DailyWorkReport" ADD CONSTRAINT "DailyWorkReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."DWRTask" ADD CONSTRAINT "DWRTask_dwrId_fkey" FOREIGN KEY ("dwrId") REFERENCES "projects"."DailyWorkReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."DWRTask" ADD CONSTRAINT "DWRTask_boqItemId_fkey" FOREIGN KEY ("boqItemId") REFERENCES "projects"."BOQTaskItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."Revenue" ADD CONSTRAINT "Revenue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."RABill" ADD CONSTRAINT "RABill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."WorkOrder" ADD CONSTRAINT "WorkOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."ProjectBudget" ADD CONSTRAINT "ProjectBudget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."ProjectDocument" ADD CONSTRAINT "ProjectDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GSTIN is unique per company only when present. Prisma has no syntax for a partial
-- index, so this is hand-authored: a plain UNIQUE would work by accident (Postgres
-- treats every NULL as distinct, so GSTIN-less clients would not collide), and
-- relying on that accident hides the rule from anyone reading schema.prisma.
CREATE UNIQUE INDEX "Client_companyId_gstin_key"
  ON "projects"."Client"("companyId", "gstin")
  WHERE "gstin" IS NOT NULL;
