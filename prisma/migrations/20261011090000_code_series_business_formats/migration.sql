-- Project, vendor and work-order codes take their business format (2026-10-11).
--
-- The three series now render as `1010` / `2022001` / `1500001` instead of
-- `{shortCode}-{infix}-{0001}`. The format lives in `code-series.formats.ts`; this
-- migration is only about where each counter resumes from.
--
-- **Counters reset to zero, so the first code under the new format is the first code the
-- business asked for** — 1010, 2022001, 1500001 — and not 1040 or 2022004 because three
-- rows happened to exist already. Without this the change is correct and still looks wrong
-- on every database that is not brand new, which is all of them.
--
-- Safe, because the two formats cannot collide: everything allocated before today reads
-- `PRPL-PRJ-0001`, everything after reads `1010`, and `@@unique([companyId, code])` refuses
-- the overlap that does not exist anyway. A code somebody typed by hand *could* occupy a
-- number the series is about to reach — that surfaces as the 409 the create path already
-- raises, not as a duplicate.
--
-- No schema change. Hand-written for that reason, following the `20261007090000` precedent:
-- `prisma migrate diff` generates nothing for a migration that only moves data.
UPDATE "settings"."CodeSequence"
SET "lastNumber" = 0, "updatedAt" = NOW()
WHERE "seriesType" IN ('PROJECTS', 'VENDORS', 'WORK_ORDER');
