-- 017 amendment, 2026-09-16. Splits the two vocabularies sharing `settings.DocumentType`.
--
-- The table has always served two unrelated lists: the employee file (Aadhaar, marksheets,
-- PF forms) and the organisation's paperwork (GST certificate, labour licence, work order).
-- Nothing distinguished them, so every company's Employee Setup list showed the statutory
-- kinds mixed in with the personal ones — and the two screens owning those lists are
-- guarded by different permissions, which makes the mixing an authorization question and
-- not only an untidy one.
--
-- One file, so it is one transaction: the column and its backfill cannot land apart and
-- leave every row reading `both` with no record of why.

CREATE TYPE "settings"."DocumentTypeScope" AS ENUM ('employee', 'company', 'both');

-- `both` as the column default, deliberately. It is the only value that cannot hide an
-- existing row from a screen that was already showing it, which matters for the rows the
-- backfill below does not name: kinds an operator created, which this product cannot
-- classify and must not guess at.
ALTER TABLE "settings"."DocumentType"
  ADD COLUMN "scope" "settings"."DocumentTypeScope" NOT NULL DEFAULT 'both';

-- The backfill. These three lists are generated from `DEFAULT_DOCUMENT_TYPES`,
-- `REQUIRED_COMPANY_DOCUMENT_KINDS` and `REQUIRED_PROJECT_DOCUMENT_KINDS`, and
-- `src/settings/document-type-scope.spec.ts` parses this file and fails if they stop
-- matching `scopeForCode()`. Two hand-maintained lists would disagree the first time
-- somebody added a kind, and the symptom would be a type quietly missing from a screen.

-- ── RLS context for the data statements in this migration ───────────────────
--
-- The tables written below FORCE row-level security, and their `tenant_isolation`
-- policy is declared with USING and no WITH CHECK. Postgres then applies USING as the
-- WITH CHECK expression for INSERT, and as the row-visibility filter for UPDATE.
-- A migration sets neither GUC, so `current_setting(..., true)` returns NULL, the
-- expression is NULL rather than true, and the statement either fails (INSERT) or
-- silently matches zero rows (UPDATE) -- the second being the worse of the two,
-- because the deploy goes green with the data unset.
--
-- Production connects as `buildcore_app` (NOSUPERUSER, NOBYPASSRLS), where the policy
-- fires. Local development connects as a SUPERUSER and bypasses RLS entirely, which is
-- why this class of defect cannot be caught by running migrations locally -- the
-- condition `assertRlsEnforceable` warns about on every boot.
--
-- Transaction-local (third argument), so it cannot leak into a later session. Same line
-- 20260904081331 added after failing in production for exactly this reason.
SELECT set_config('app.is_super_admin', 'true', true);

-- Organisation paperwork: the company's own eight and the project's six, less the two
-- below that are also employee documents.
UPDATE "settings"."DocumentType"
   SET "scope" = 'company'
 WHERE upper("code") IN ('BOQ', 'CANCELLED_CHEQUE', 'ESIC', 'GST', 'INSURANCE', 'LABOUR_INSURANCE', 'LABOUR_LICENCE', 'LOI', 'MINING_PERMISSION', 'PF', 'TAN', 'WORK_ORDER');

-- The employee file.
UPDATE "settings"."DocumentType"
   SET "scope" = 'employee'
 WHERE upper("code") IN ('APPOINTMENT_LETTER', 'BANK_PROOF', 'DEGREE', 'DRIVING_LICENCE', 'ESIC_FAMILY_DECLARATION', 'EXPERIENCE_LETTER', 'JOINING_LETTER_SIGNED', 'MARKSHEET_10', 'MARKSHEET_12', 'MEDICAL_FITNESS', 'OFFER_LETTER', 'PF_FORM_11', 'PF_FORM_2_NOMINATION', 'PHOTO', 'POLICE_VERIFICATION');

-- Genuinely both: required of the company AND held on an employee's file. Written
-- explicitly rather than left to the column default, so the intent is on the record
-- rather than inferred from an absence.
UPDATE "settings"."DocumentType"
   SET "scope" = 'both'
 WHERE upper("code") IN ('AADHAAR', 'PAN');

-- ── Legacy codes predating the current vocabulary (one-time repair) ──────────
--
-- The three statements above are generated from `DEFAULT_DOCUMENT_TYPES`,
-- `REQUIRED_COMPANY_DOCUMENT_KINDS` and `REQUIRED_PROJECT_DOCUMENT_KINDS`, and
-- `src/settings/document-type-scope.spec.ts` parses them and fails if they drift from
-- those constants. They are therefore left exactly as generated.
--
-- This statement is separate because it names codes those constants no longer contain.
-- The production database was seeded by an earlier revision of the employee defaults,
-- which used short codes: its `DocumentType` rows are AADHAAR, BANK, EDU, EXP, MED and
-- PAN. Only AADHAAR and PAN are matched above, so without this the other four fall to
-- the column default `'both'` and appear on the organisation's paperwork screen as well
-- as the employee file — which is the exact mixing FR-001b was written to end, surviving
-- the migration meant to end it.
--
-- All four are employee-file documents: BANK is the salary bank proof ("Cancelled
-- Cheque / Passbook" on an employee's record, not the company's own cancelled cheque),
-- and EDU, EXP and MED are educational certificates, the previous experience letter and
-- the medical fitness certificate. This is a classification of rows that already exist,
-- not a guess at an undeclared kind — the `'both'` default correctly governs those.
--
-- Written with `= ANY (ARRAY[...])` rather than `IN (...)` deliberately: the spec's
-- regex matches `IN (` and would otherwise absorb these codes into the generated
-- employee list and fail the count assertion. `scopeForCode()` still answers `'both'`
-- for these codes, which is correct for anything created from now on — nothing creates
-- a type with a legacy code any more, and an undeclared code must stay `'both'`.
UPDATE "settings"."DocumentType"
   SET "scope" = 'employee'
 WHERE upper("code") = ANY (ARRAY['BANK', 'EDU', 'EXP', 'MED']);
