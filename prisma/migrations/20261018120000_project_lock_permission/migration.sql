-- 036 review decision 5 (2026-10-18): locking and unlocking a project gets its own permission,
-- separate from PROJECTS.
--
-- The enum value is not used in this migration, so adding it in this transaction is safe; the
-- grants that use it are in the next migration for that reason (Postgres refuses a new enum value
-- in the transaction that added it).

-- AlterEnum
ALTER TYPE "settings"."Permission" ADD VALUE 'PROJECT_LOCK';
