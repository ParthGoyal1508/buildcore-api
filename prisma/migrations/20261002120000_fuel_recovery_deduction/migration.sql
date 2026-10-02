-- 020 FR-007: a fuel recovery is a named deduction, distinct from a loan or an advance.
--
-- Additive and defaulted to zero, so every existing payroll line and payslip keeps the figure it
-- was issued with. A required column would have meant inventing a deduction for months that never
-- had one.
ALTER TABLE "payroll"."PayrollLineItem"
  ADD COLUMN "fuelRecoveryDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "payroll"."SalarySlip"
  ADD COLUMN "deductionFuelRecovery" DECIMAL(12,2) NOT NULL DEFAULT 0;
