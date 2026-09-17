-- 016 FR-009 / US3 scenario 4: an item's approval history is readable only by someone
-- permitted to see the item. The spine cannot dereference `entityId` to ask the owning
-- module, so the owning module declares the answer at submit time and it is stored here.
--
-- Three statements rather than one, because the column is required and the table is not
-- empty. Adding it NOT NULL outright fails on any environment that already carries
-- instances — which, after this feature's Phase 2 backfill, is every one of them.

-- 1. Add it nullable, so existing rows survive the DDL.
ALTER TABLE "shared"."ApprovalInstance"
  ADD COLUMN "viewPermission" "settings"."Permission";

-- 2. Backfill from the chain's action type. These are the only three action types that
--    exist at the time of writing; the ELSE is not a guess but a deliberate fail-safe —
--    `SETTINGS` is the narrowest permission in the enum, so an action type this migration
--    has never heard of ends up readable by administrators only rather than by everyone.
UPDATE "shared"."ApprovalInstance" AS i
SET "viewPermission" = CASE c."actionType"
  WHEN 'attendance_exception'        THEN 'ATTENDANCE'::"settings"."Permission"
  WHEN 'attendance_exception_legacy' THEN 'ATTENDANCE'::"settings"."Permission"
  WHEN 'payroll_run'                 THEN 'PAYROLL'::"settings"."Permission"
  ELSE 'SETTINGS'::"settings"."Permission"
END
FROM "shared"."ApprovalChain" AS c
WHERE c."id" = i."chainId" AND i."viewPermission" IS NULL;

-- 3. Now it can be required, which is the point: a module that forgets to declare who may
--    read its items fails at submit rather than shipping an open history endpoint.
ALTER TABLE "shared"."ApprovalInstance"
  ALTER COLUMN "viewPermission" SET NOT NULL;
