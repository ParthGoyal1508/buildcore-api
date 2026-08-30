-- Closes the three gaps between feature 003's design artifacts and the schema as
-- 20260830082355_my_workspace_entities left it:
--
--   1. `payroll.SalarySlip` — data-model.md's "Salary Slip" read projection. US5
--      serves a payslip; without a table to serve it from, the endpoint has
--      nothing to read.
--   2. `settings.ReimbursementCategory` — the per-company master US8's claims
--      validate their mandatory-receipt threshold against (research.md §10).
--      Feature 005 owns its admin CRUD; 003 only reads it.
--   3. `hr.ReimbursementClaim` — the claim itself, plus the audit entity type its
--      writes are recorded under.

-- CreateEnum
CREATE TYPE "hr"."ReimbursementClaimStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'paid', 'withdrawn');

-- CreateEnum
CREATE TYPE "hr"."ReimbursementPaymentMode" AS ENUM ('payroll', 'direct');

-- AlterEnum
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'REIMBURSEMENT_CLAIM';

-- CreateTable
CREATE TABLE "settings"."ReimbursementCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "receiptRequiredAbove" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."ReimbursementClaim" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expenseDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "receiptRef" TEXT,
    "status" "hr"."ReimbursementClaimStatus" NOT NULL DEFAULT 'submitted',
    "paymentMode" "hr"."ReimbursementPaymentMode",
    "paymentReference" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "adminRemarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll"."SalarySlip" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "monthDays" INTEGER NOT NULL,
    "payableDays" DECIMAL(5,2) NOT NULL,
    "lopDays" DECIMAL(5,2) NOT NULL,
    "otHours" DECIMAL(6,2) NOT NULL,
    "earningBasic" DECIMAL(12,2) NOT NULL,
    "earningHra" DECIMAL(12,2) NOT NULL,
    "earningConveyance" DECIMAL(12,2) NOT NULL,
    "earningSiteAllowance" DECIMAL(12,2) NOT NULL,
    "earningSpecialAllowance" DECIMAL(12,2) NOT NULL,
    "earningOt" DECIMAL(12,2) NOT NULL,
    "deductionPf" DECIMAL(12,2) NOT NULL,
    "deductionEsic" DECIMAL(12,2) NOT NULL,
    "deductionPt" DECIMAL(12,2) NOT NULL,
    "deductionTds" DECIMAL(12,2) NOT NULL,
    "deductionLoanEmi" DECIMAL(12,2) NOT NULL,
    "deductionAdvanceRecovery" DECIMAL(12,2) NOT NULL,
    "employerPf" DECIMAL(12,2) NOT NULL,
    "employerEps" DECIMAL(12,2) NOT NULL,
    "employerEdli" DECIMAL(12,2) NOT NULL,
    "employerAdminCharges" DECIMAL(12,2) NOT NULL,
    "employerGratuity" DECIMAL(12,2) NOT NULL,
    "employerBonus" DECIMAL(12,2) NOT NULL,
    "netPay" DECIMAL(12,2) NOT NULL,
    "minimumWagesNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalarySlip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReimbursementCategory_companyId_idx" ON "settings"."ReimbursementCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementCategory_companyId_code_key" ON "settings"."ReimbursementCategory"("companyId", "code");

-- CreateIndex
CREATE INDEX "ReimbursementClaim_employeeId_status_idx" ON "hr"."ReimbursementClaim"("employeeId", "status");

-- CreateIndex
CREATE INDEX "ReimbursementClaim_companyId_status_idx" ON "hr"."ReimbursementClaim"("companyId", "status");

-- CreateIndex
CREATE INDEX "SalarySlip_employeeId_idx" ON "payroll"."SalarySlip"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SalarySlip_employeeId_period_key" ON "payroll"."SalarySlip"("employeeId", "period");

-- AddForeignKey
ALTER TABLE "settings"."ReimbursementCategory" ADD CONSTRAINT "ReimbursementCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."ReimbursementClaim" ADD CONSTRAINT "ReimbursementClaim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll"."SalarySlip" ADD CONSTRAINT "SalarySlip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
