-- 021 Phases 4 and 5: `bugs.md` items 8 (salary slips reach the employee) and 9 (advances settle
-- against the transfer).

CREATE TYPE "payroll"."SlipDeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'undeliverable');

-- One attempt to email one employee their payslip.
CREATE TABLE "payroll"."SlipDelivery" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "payrollRunId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  -- The address **as sent**. An employee whose email is corrected after a failure must not have the
  -- old failure read as though it went to the new address, which is what a join at read time shows.
  "address" TEXT NOT NULL,
  "status" "payroll"."SlipDeliveryStatus" NOT NULL DEFAULT 'pending',
  "failureReason" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SlipDelivery_pkey" PRIMARY KEY ("id")
);

-- **This constraint is what makes the retry safe.** With it a retry is an upsert per employee, so
-- running it twice sends once. Without it, "retry the failures" and "retry everything" differ only by
-- the correctness of a filter, and the failure mode is 500 people receiving a second copy of their
-- salary slip.
--
-- Keyed on the employee, not the address: several employees at one site can share a mailbox and each
-- must get their own slip.
CREATE UNIQUE INDEX "SlipDelivery_run_employee_key"
  ON "payroll"."SlipDelivery" ("payrollRunId", "employeeId");
CREATE INDEX "SlipDelivery_companyId_idx" ON "payroll"."SlipDelivery" ("companyId");
CREATE INDEX "SlipDelivery_run_status_idx"
  ON "payroll"."SlipDelivery" ("payrollRunId", "status");

-- `address` is personal data (Principle IV), so an explicit WITH CHECK as well as USING: a policy
-- with only USING filters reads and admits any write that names another tenant.
ALTER TABLE "payroll"."SlipDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."SlipDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."SlipDelivery"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- An advance recovered from the transfer rather than from the approved run.
CREATE TABLE "payroll"."BankSheetRecovery" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "payrollRunId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "salaryAdvanceId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BankSheetRecovery_pkey" PRIMARY KEY ("id")
);

-- **This constraint IS FR-013** — "MUST NOT recover the same advance twice" — enforced by the
-- database rather than by a check somebody has to remember in a path that regenerates a bank sheet.
CREATE UNIQUE INDEX "BankSheetRecovery_run_advance_key"
  ON "payroll"."BankSheetRecovery" ("payrollRunId", "salaryAdvanceId");
CREATE INDEX "BankSheetRecovery_companyId_idx"
  ON "payroll"."BankSheetRecovery" ("companyId");
CREATE INDEX "BankSheetRecovery_payrollRunId_idx"
  ON "payroll"."BankSheetRecovery" ("payrollRunId");

ALTER TABLE "payroll"."BankSheetRecovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."BankSheetRecovery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."BankSheetRecovery"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
