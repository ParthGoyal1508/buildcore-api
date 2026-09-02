-- CreateEnum
CREATE TYPE "settings"."TaxRegime" AS ENUM ('old', 'new');

-- CreateEnum
CREATE TYPE "hr"."TaxDeclarationStatus" AS ENUM ('declared', 'verified');

-- CreateEnum
CREATE TYPE "hr"."SalaryAdvanceStatus" AS ENUM ('pending', 'approved', 'disbursed', 'closed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'TAX_DECLARATION';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'SALARY_ADVANCE';

-- DropIndex
DROP INDEX "hr"."EmployeeTransfer_employeeId_fromCompanyId_idx";

-- CreateTable
CREATE TABLE "settings"."TaxSlab" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "regime" "settings"."TaxRegime" NOT NULL,
    "lowerBound" DECIMAL(14,2) NOT NULL,
    "upperBound" DECIMAL(14,2),
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxSlab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."TaxDeclaration" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "regime" "settings"."TaxRegime" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."TaxDeclarationLine" (
    "id" TEXT NOT NULL,
    "declarationId" TEXT NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "declaredAmount" DECIMAL(14,2) NOT NULL,
    "cappedAmount" DECIMAL(14,2) NOT NULL,
    "status" "hr"."TaxDeclarationStatus" NOT NULL DEFAULT 'declared',
    "proofRef" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "TaxDeclarationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."SalaryAdvance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "recoveryMonth" TEXT NOT NULL,
    "outstandingBalance" DECIMAL(12,2) NOT NULL,
    "exceedsLimit" BOOLEAN NOT NULL DEFAULT false,
    "status" "hr"."SalaryAdvanceStatus" NOT NULL DEFAULT 'pending',
    "approvedByUserId" TEXT,
    "disbursedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxSlab_companyId_financialYear_regime_idx" ON "settings"."TaxSlab"("companyId", "financialYear", "regime");

-- CreateIndex
CREATE UNIQUE INDEX "TaxSlab_companyId_financialYear_regime_lowerBound_key" ON "settings"."TaxSlab"("companyId", "financialYear", "regime", "lowerBound");

-- CreateIndex
CREATE INDEX "TaxDeclaration_employeeId_idx" ON "hr"."TaxDeclaration"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxDeclaration_employeeId_financialYear_key" ON "hr"."TaxDeclaration"("employeeId", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "TaxDeclarationLine_declarationId_sectionCode_key" ON "hr"."TaxDeclarationLine"("declarationId", "sectionCode");

-- CreateIndex
CREATE INDEX "SalaryAdvance_employeeId_status_idx" ON "hr"."SalaryAdvance"("employeeId", "status");

-- CreateIndex
CREATE INDEX "SalaryAdvance_recoveryMonth_idx" ON "hr"."SalaryAdvance"("recoveryMonth");

-- AddForeignKey
ALTER TABLE "hr"."TaxDeclaration" ADD CONSTRAINT "TaxDeclaration_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."TaxDeclarationLine" ADD CONSTRAINT "TaxDeclarationLine_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "hr"."TaxDeclaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the amendment's tables, following the same scoping rule as the rest of
-- feature 005: company-level masters carry companyId; employee-owned records are
-- scoped through the Employee (and therefore follow a US8 transfer correctly).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "settings"."TaxSlab" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."TaxSlab" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."TaxSlab"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "hr"."TaxDeclaration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."TaxDeclaration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."TaxDeclaration"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."TaxDeclaration"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- Scoped through its declaration, which is itself scoped through the employee.
ALTER TABLE "hr"."TaxDeclarationLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."TaxDeclarationLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."TaxDeclarationLine"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."TaxDeclaration" d
      JOIN "hr"."Employee" e ON e."id" = d."employeeId"
      WHERE d."id" = "hr"."TaxDeclarationLine"."declarationId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."SalaryAdvance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."SalaryAdvance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."SalaryAdvance"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."SalaryAdvance"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- At most one open advance per employee (FR-054). A partial unique index, because
-- the rule is "one *open* advance", not "one advance ever".
CREATE UNIQUE INDEX "SalaryAdvance_one_open_per_employee"
  ON "hr"."SalaryAdvance" ("employeeId")
  WHERE "status" <> 'closed';
