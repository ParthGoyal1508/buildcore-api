-- 020 FR-007b: a recovery the 50% ceiling could not settle in one period carries its balance.
--
-- `amount` is what is owed; `recoveredAmount` is what has actually been deducted. The balance is the
-- difference, which makes a carried balance readable without reconstructing it from payroll history —
-- FR-007c requires it to stay visible rather than be quietly disposed of.
ALTER TABLE "plant"."OperatorFuelRecovery"
  ADD COLUMN "recoveredAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;
