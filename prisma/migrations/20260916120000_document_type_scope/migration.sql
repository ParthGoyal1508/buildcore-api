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
