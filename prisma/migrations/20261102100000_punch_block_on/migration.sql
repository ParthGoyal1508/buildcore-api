-- 057: a punch that fails the face or location check is refused, for every company.
--
-- The client's decision (2026-11-02), taken after the refusal log had measured the block. The column
-- and every branch that reads it stay, and the Settings toggle is only hidden, so switching a company
-- back to "record as an exception" is an UPDATE rather than a release.
ALTER TABLE "settings"."Company" ALTER COLUMN "punchBlockEnforced" SET DEFAULT true;
UPDATE "settings"."Company" SET "punchBlockEnforced" = true WHERE "punchBlockEnforced" = false;
