-- 036 stream 1a (payroll). Recoveries settle when a run is processed, not when it is drafted
-- (F1/F2, decision 1), so the draft has to remember what it planned to recover; the payslip gets
-- the advance figure it was missing (F3); processing settles only the claims the run carried (F4);
-- run exceptions are kept (F7); advances and loans record who created them for maker-checker (F19).
-- Additive only: every new column is nullable or has a default.

-- AlterTable
ALTER TABLE "hr"."SalaryAdvance" ADD COLUMN     "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "payroll"."Loan" ADD COLUMN     "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "payroll"."PayrollLineItem" ADD COLUMN     "advanceRecovered" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "advanceRecoveryAdvanceId" TEXT,
ADD COLUMN     "fuelRecoveries" JSONB,
ADD COLUMN     "reimbursementClaimIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reimbursementTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payroll"."PayrollRun" ADD COLUMN     "exceptions" JSONB,
ADD COLUMN     "recoveriesSettledAt" TIMESTAMP(3);

-- Backfill `advanceRecovered` on existing regular-run lines (F3). Not stored before, but fully
-- determined: the engine wrote netPay = gross − statutory/TDS/EMI − fuel − advance, so the advance
-- is whatever gross − the stored deductions − netPay leaves. Floored at zero because the engine
-- floors net pay at zero before any advance is taken (a line whose deductions exceeded gross
-- recovered no advance). F&F runs are excluded: they fold the advance into `loanEmiDeduction`.
-- This fills a derived column; it does not touch any advance balance (decision 10: report only).
UPDATE "payroll"."PayrollLineItem" li
SET "advanceRecovered" = GREATEST(
  0,
  ROUND(
    (li."basic" + li."hra" + li."conveyanceAllowance" + li."siteAllowance" + li."specialAllowance" + li."otWages")
    - (li."employeePf" + li."employeeEsic" + li."professionalTax" + li."tds" + li."loanEmiDeduction" + li."fuelRecoveryDeduction")
    - li."netPay",
    2
  )
)
FROM "payroll"."PayrollRun" r
WHERE r."id" = li."payrollRunId" AND r."isFnf" = false;

-- Backfill the creator from the audit trail, so maker-checker (F19) also covers pending rows
-- recorded before this column existed.
UPDATE "hr"."SalaryAdvance" a
SET "createdByUserId" = e."accountId"
FROM "shared"."AuditLogEntry" e
WHERE e."entityType" = 'SALARY_ADVANCE' AND e."action" = 'CREATE'
  AND e."entityId" = a."id" AND a."createdByUserId" IS NULL;

UPDATE "payroll"."Loan" l
SET "createdByUserId" = e."accountId"
FROM "shared"."AuditLogEntry" e
WHERE e."entityType" = 'LOAN' AND e."action" = 'CREATE'
  AND e."entityId" = l."id" AND l."createdByUserId" IS NULL;
