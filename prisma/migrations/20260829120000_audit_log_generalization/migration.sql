-- Generalizes feature 001's login-only `AuditLogEntry.eventType` into the
-- `entityType` + `action` pair feature 002 needs, so both features share one audit
-- trail instead of growing a per-module enum (002 research.md §9, data-model.md
-- "Audit Log Entry").
--
-- `prisma migrate dev` cannot generate this unassisted: the two new columns are
-- NOT NULL and the table already holds 38 login rows. The add-nullable → backfill →
-- constrain shape below is the same one 20260828170000_role_permission_model used
-- for its own UserRole backfill.

-- CreateEnum
CREATE TYPE "shared"."AuditEntityType" AS ENUM (
  'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'ACCOUNT_LOCKED', 'LOGOUT',
  'REFRESH_REUSE_DETECTED', 'ADMIN_PASSWORD_RESET',
  'COMPANY', 'ROLE', 'DEPARTMENT', 'DESIGNATION', 'DOCUMENT_TYPE', 'SHIFT',
  'USER_ACCOUNT'
);

-- CreateEnum
CREATE TYPE "shared"."AuditAction" AS ENUM (
  'CREATE', 'UPDATE', 'DELETE',
  'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'ACCOUNT_LOCKED', 'LOGOUT',
  'REFRESH_REUSE_DETECTED', 'ADMIN_PASSWORD_RESET'
);

-- AlterTable: nullable first, so existing rows survive the backfill below.
ALTER TABLE "shared"."AuditLogEntry"
  ADD COLUMN "entityType" "shared"."AuditEntityType",
  ADD COLUMN "action"     "shared"."AuditAction",
  ADD COLUMN "entityId"   TEXT,
  ADD COLUMN "changes"    JSONB;

-- Backfill: every pre-existing row is a login-lifecycle event, whose old lowercase
-- enum value maps 1:1 onto both new columns (the event *is* both what happened and
-- what it happened to).
UPDATE "shared"."AuditLogEntry"
SET "entityType" = upper("eventType"::text)::"shared"."AuditEntityType",
    "action"     = upper("eventType"::text)::"shared"."AuditAction";

ALTER TABLE "shared"."AuditLogEntry"
  ALTER COLUMN "entityType" SET NOT NULL,
  ALTER COLUMN "action"     SET NOT NULL;

-- DropColumn + DropEnum (superseded by the two columns above)
ALTER TABLE "shared"."AuditLogEntry" DROP COLUMN "eventType";
DROP TYPE "shared"."AuditEventType";
