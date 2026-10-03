-- 008 FR-014 (amended 2026-10-03): one audit entry per BOQ import.
--
-- Separate from BOQ_GROUP and BOQ_ITEM because those describe rows. An import logged per row
-- would write 231 entries for the client's own tender and bury whatever came next in the log.

SELECT set_config('app.is_super_admin', 'true', true);

ALTER TYPE "shared"."AuditEntityType" ADD VALUE IF NOT EXISTS 'BOQ_IMPORT';
