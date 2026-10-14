-- The HR letters permission (2026-10-15): issuing appointment, experience, relieving, increment,
-- termination, transfer and F&F letters. Granted in the next migration: Postgres refuses to use a
-- new enum value inside the transaction that added it.
ALTER TYPE "settings"."Permission" ADD VALUE IF NOT EXISTS 'HR_LETTERS';
