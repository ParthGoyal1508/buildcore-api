-- One punch-in and one punch-out per employee per calendar day (spec FR-008).
--
-- Hand-ordered rather than left as Prisma generated it: `punchDate` cannot be added
-- NOT NULL to a populated table, and the new unique index cannot be created while
-- rows recorded under the old rule (several pairs a day) still count as employee
-- punches. Both are handled below, in order.

-- CreateEnum
CREATE TYPE "hr"."PunchSource" AS ENUM ('employee', 'admin_correction', 'legacy');

-- AlterTable: `source` takes its default immediately; `punchDate` arrives nullable
-- so existing rows can be backfilled before the constraint lands.
ALTER TABLE "hr"."PunchRecord"
  ADD COLUMN "punchDate" DATE,
  ADD COLUMN "source" "hr"."PunchSource" NOT NULL DEFAULT 'employee';

-- Backfill the calendar day each existing punch belongs to. `capturedAt` is a
-- `timestamp` holding UTC, so it is read as UTC and then converted to the zone the
-- application reckons days in.
--
-- The zone is written literally here, unlike everywhere else in the system, because
-- this is a one-off rewrite of historical rows rather than a runtime decision: a
-- backfill must produce the same result whenever it is replayed, which a value read
-- from the environment at migration time would not.
UPDATE "hr"."PunchRecord"
SET "punchDate" = (("capturedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date
WHERE "punchDate" IS NULL;

ALTER TABLE "hr"."PunchRecord" ALTER COLUMN "punchDate" SET NOT NULL;

-- Every row that exists at this point predates FR-008 and may hold several pairs on
-- one day. Marking them `legacy` exempts them from the index created below, which is
-- what lets the rule take effect going forward without deleting recorded attendance.
--
-- Bounded by `createdAt` rather than by "all rows", so replaying this statement can
-- never reclassify punches made after the migration.
UPDATE "hr"."PunchRecord"
SET "source" = 'legacy'
WHERE "createdAt" <= NOW() AND "source" = 'employee';

-- CreateIndex
CREATE INDEX "PunchRecord_employeeId_punchDate_idx" ON "hr"."PunchRecord"("employeeId", "punchDate");

-- The old backstop for "one open punch-in at a time" has to go, not sit alongside
-- the new one. FR-008a requires a punch-in left open on an earlier day to stop
-- blocking today's, which means two rows with type = 'in' and closedByPunchId IS
-- NULL must be able to coexist — precisely what this index forbids. Its rule is
-- subsumed anyway: a day now admits at most one punch-in.
DROP INDEX IF EXISTS "hr"."PunchRecord_one_open_punch_in_per_employee";

-- The database-level backstop for FR-008, replacing it. Scoped to employee-made
-- punches (FR-008c) so an administrative correction is not forbidden by the schema,
-- and so the legacy rows marked above are left alone.
CREATE UNIQUE INDEX "PunchRecord_one_punch_per_type_per_day"
  ON "hr"."PunchRecord" ("employeeId", "type", "punchDate")
  WHERE "source" = 'employee';
