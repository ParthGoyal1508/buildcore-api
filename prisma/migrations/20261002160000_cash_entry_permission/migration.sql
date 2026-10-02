-- 019 FR-017a: recording a payment in cash becomes a permission of its own.
--
-- Its own migration, with nothing else in it, because PostgreSQL cannot add an enum value and
-- use it in the same transaction. The grants that preserve today's behaviour are the next
-- migration for exactly that reason — they are a *use* of this value.
ALTER TYPE "settings"."Permission" ADD VALUE IF NOT EXISTS 'CASH_ENTRY';
