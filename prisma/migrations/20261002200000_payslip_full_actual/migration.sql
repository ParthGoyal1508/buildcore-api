-- 021 Phase 9 (T104, T105): the payslip prints earnings as Full and Actual side by side, per
-- `docs/NC0060_Payslip_Feb 2026.pdf`.
--
-- Stored rather than derived from the employee master on read: a salary revision next year would
-- otherwise retroactively rewrite the Full column of a payslip already issued. The `earning*`
-- columns are stored for precisely that reason.
--
-- Nullable with **no backfill**, deliberately. Slips issued before today have no record of their
-- unprorated entitlement, and copying the Actual figure across would assert a fact we do not have —
-- it would read as "no LOP that month" on exactly the slips where there might have been some. The
-- PDF prints an em dash instead.
ALTER TABLE "payroll"."SalarySlip"
  ADD COLUMN "fullEarningBasic" DECIMAL(12,2),
  ADD COLUMN "fullEarningHra" DECIMAL(12,2),
  ADD COLUMN "fullEarningConveyance" DECIMAL(12,2),
  ADD COLUMN "fullEarningSiteAllowance" DECIMAL(12,2),
  ADD COLUMN "fullEarningSpecialAllowance" DECIMAL(12,2);
