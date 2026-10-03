-- 008 FR-037 (amended 2026-10-03): a BOQ line may exist without a programme.
--
-- A tender schedule of quantities carries quantity, unit and rate and no dates. Requiring the
-- programme columns meant either refusing to import the client's own file or inventing a
-- programme for all 312 of its lines, and an invented finish date makes the "Delayed" alert
-- report fiction. Planning becomes a separate act, performed on the BOQ screen afterwards.
--
-- Nothing is added here. Six columns are widened to nullable, which is safe on a populated table,
-- and no backfill is needed: nothing in the codebase has ever written to either table.

SELECT set_config('app.is_super_admin', 'true', true);

ALTER TABLE "projects"."BOQTaskGroup"
  ALTER COLUMN "startDate"  DROP NOT NULL,
  ALTER COLUMN "finishDate" DROP NOT NULL;

ALTER TABLE "projects"."BOQTaskItem"
  ALTER COLUMN "startDate"  DROP NOT NULL,
  ALTER COLUMN "finishDate" DROP NOT NULL,
  ALTER COLUMN "duration"   DROP NOT NULL,
  ALTER COLUMN "perDayQty"  DROP NOT NULL;

COMMENT ON COLUMN "projects"."BOQTaskItem"."finishDate" IS
  'Null means unplanned. getAlerts decides alert-group membership on this column alone (FR-048), so a partially planned line has exactly one home.';
