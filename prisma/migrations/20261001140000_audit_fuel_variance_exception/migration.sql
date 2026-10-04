-- 020 Phase 5, 2026-10-01. An audit entity for the review decision.
--
-- Separate from the table migration because `ALTER TYPE ... ADD VALUE` and a use of the new value
-- cannot share a transaction in Postgres. Nothing here uses it; the first use is in application code.
--
-- The entity is the **decision**, not the reading. A review never alters `varianceAlert` or
-- `variancePercent` (FR-017) — the reading is the evidence the decision rests on.

ALTER TYPE "shared"."AuditEntityType" ADD VALUE IF NOT EXISTS 'FUEL_VARIANCE_EXCEPTION';
