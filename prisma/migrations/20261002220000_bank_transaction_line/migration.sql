-- 021 Phase 6 (FR-008 to FR-011): the bank's own transaction sheet, reconciled against the run.
--
-- Lines are stored **whether or not they matched**. SC-004 asks that every line be either matched or
-- reported, and a parser that rejects the file on its first unrecognised row reports none of them —
-- so an unreadable row is a row here with a reason, and the upload still succeeds.
CREATE TABLE "payroll"."BankTransactionLine" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "payrollRunId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  -- The raw fields as the file gave them. Not normalised: matching normalises a copy, and storing
  -- the normalised form would lose the leading zero that is part of the account number.
  "beneficiaryName" TEXT,
  "beneficiaryAccount" TEXT,
  "ifsc" TEXT,
  "amount" DECIMAL(12,2),
  "matchedPayrollLineItemId" TEXT,
  "unmatchedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BankTransactionLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BankTransactionLine_companyId_idx"
  ON "payroll"."BankTransactionLine" ("companyId");
CREATE INDEX "BankTransactionLine_payrollRunId_idx"
  ON "payroll"."BankTransactionLine" ("payrollRunId");

-- `beneficiaryAccount` is personal data, so an explicit WITH CHECK as well as USING.
ALTER TABLE "payroll"."BankTransactionLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."BankTransactionLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."BankTransactionLine"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
