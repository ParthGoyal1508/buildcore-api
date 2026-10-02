-- 020 FR-002 names four attributions; Phase 5 shipped three. `both` was missed and is added here.
--
-- Its own migration because PostgreSQL cannot add an enum value and use it in the same
-- transaction, and the next migration or seed that references it would fail if they shared one.
ALTER TYPE "plant"."FuelAttribution" ADD VALUE IF NOT EXISTS 'both' BEFORE 'neither';
