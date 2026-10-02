-- 020 FR-007a: the ceiling on total deductions from one payslip.
--
-- Defaulted to 50, the figure the client confirmed on 2026-10-02, and bounded at 50 by a check
-- constraint rather than by convention. A mistake in this value does not produce a slightly wrong
-- payslip; it produces an unlawful one. Lowering it is permitted — a company may be stricter than the
-- Act, never laxer.
ALTER TABLE "settings"."Company"
  ADD COLUMN "deductionCeilingPercent" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "settings"."Company"
  ADD CONSTRAINT "Company_deductionCeilingPercent_within_statute"
  CHECK ("deductionCeilingPercent" > 0 AND "deductionCeilingPercent" <= 50);
