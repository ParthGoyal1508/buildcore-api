-- 2026-10-20. "One open advance per employee" (FR-054) must not count a rejected advance as open:
-- an advance its approval chain refused would otherwise block every advance after it. A migration
-- of its own because Postgres refuses to use an enum value in the transaction that added it
-- (20261020120000 adds `rejected`).
DROP INDEX IF EXISTS "hr"."SalaryAdvance_one_open_per_employee";
CREATE UNIQUE INDEX "SalaryAdvance_one_open_per_employee"
  ON "hr"."SalaryAdvance" ("employeeId")
  WHERE "status" NOT IN ('closed', 'rejected');
