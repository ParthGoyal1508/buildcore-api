-- AlterTable
ALTER TABLE "projects"."DWRTask" ADD COLUMN     "equipmentId" TEXT,
ADD COLUMN     "servedQty" DECIMAL(18,3),
ALTER COLUMN "actualQty" DROP NOT NULL;

-- AlterTable
ALTER TABLE "projects"."DailyWorkReport" ADD COLUMN     "reversalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reversedByUserId" TEXT;

-- The one statement in this migration that Prisma did not generate (022 T006).
--
-- The invariant is: exactly one of `actualQty` and `servedQty` is present, and which one matches
-- `paymentMode`. Prisma's schema language cannot express a constraint spanning two columns and an
-- enum, so there is no generated form of it — this is the deviation recorded in plan.md's
-- Complexity Tracking, and the rest of this file is generated as the constitution requires.
--
-- It lives here rather than in the service because the thing it protects is the quantity that
-- moves a billed counter, and a service-level invariant is one `prisma.dWRTask.create` away from
-- being bypassed. The whole point of decision D1 was to stop a quantity being right by
-- coincidence: all six measurement factors default to 1, so their product is 1, which is
-- indistinguishable from one day served. Leaving that distinction to a convention in a service
-- would reintroduce exactly the failure the design exists to prevent.
--
-- Safe to add without a backfill: `projects."DWRTask"` held 0 rows on 2026-10-04, because nothing
-- could write one until this feature built the module 008 specified and left unimplemented.
ALTER TABLE "projects"."DWRTask"
  ADD CONSTRAINT "DWRTask_quantity_matches_basis" CHECK (
    ("paymentMode" = 'work_basis' AND "actualQty" IS NOT NULL AND "servedQty" IS NULL)
    OR
    ("paymentMode" = 'day_basis'  AND "servedQty" IS NOT NULL AND "actualQty" IS NULL)
  );
