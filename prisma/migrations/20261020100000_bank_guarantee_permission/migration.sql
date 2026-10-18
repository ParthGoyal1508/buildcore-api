-- 037 Bank Guarantees: the register's own permission.
--
-- Alone in its migration because Postgres refuses a new enum value inside the transaction that
-- added it; the grants that use it are in the next migration.
ALTER TYPE "settings"."Permission" ADD VALUE 'BANK_GUARANTEES';

-- Its activity-log entity type, for the same reason in its own migration.
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'BANK_GUARANTEE';
