-- 039 flow corrections: the new enum values, alone because Postgres refuses a value inside the
-- transaction that added it; the grants that use them are in the next migration.

-- Head Office recording payment against a job card's final bill.
ALTER TYPE "settings"."Permission" ADD VALUE 'MAINTENANCE_PAY';

-- The composite item master's activity-log entity type.
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'COMPOSITE_ITEM';
