-- 017 FR-011b, FR-011c (`bugs.md` item 18): a letter kind declares its own fields.
--
-- The coupling this undoes: `LETTER_TOKENS` was keyed by the five shipped letter types, so a kind an
-- administrator defined under FR-011 got an **empty** field list and the template editor then refused
-- every field it used. Both requirements were satisfied and together they produced nothing usable.

CREATE TYPE "settings"."LetterFieldSource" AS ENUM (
  'employee', 'candidate', 'project', 'company', 'manual'
);

CREATE TABLE "settings"."LetterKindField" (
  "id" TEXT NOT NULL,
  "letterKindId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sourceType" "settings"."LetterFieldSource" NOT NULL,
  "sourcePath" TEXT,
  "isRequired" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LetterKindField_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LetterKindField_kind_token_key"
  ON "settings"."LetterKindField" ("letterKindId", "token");
CREATE INDEX "LetterKindField_letterKindId_idx"
  ON "settings"."LetterKindField" ("letterKindId");

ALTER TABLE "settings"."LetterKindField"
  ADD CONSTRAINT "LetterKindField_letterKindId_fkey"
  FOREIGN KEY ("letterKindId") REFERENCES "settings"."LetterKind"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A field that names no source is a placeholder that renders blank, and a blank in a signed letter is
-- indistinguishable from a deliberate omission. `manual` is the one honest exception — a term typed at
-- issue time has no record behind it. Enforced here rather than left to every writer to remember.
ALTER TABLE "settings"."LetterKindField"
  ADD CONSTRAINT "LetterKindField_source_path_pairing"
  CHECK (
    ("sourceType" = 'manual' AND "sourcePath" IS NULL)
    OR ("sourceType" <> 'manual' AND "sourcePath" IS NOT NULL)
  );

-- `LetterKind` is not tenant-scoped (a NULL companyId is a product-shipped kind), so neither is this.
-- Its parent's access rules govern it — the same reasoning the `LetterTemplate` migration records.

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- The backfill. **This is the risk of the whole change.**
--
-- Every live template references these tokens by name. A seed that renames or drops one breaks
-- letters already issued — so each list below is byte-identical to `LETTER_TOKENS` in
-- `src/recruitment/letters/letter-tokens.util.ts`, and `letter-kind-field.spec.ts` asserts that
-- rather than trusting two files to stay in step.
--
-- Sources are the ones the hand-written resolvers in `letter.service.ts` already read. Where a value
-- is computed rather than read — `tenure`, `issueDate` — the source is `manual`: the resolver supplies
-- it, there is no column to point at, and claiming a path that does not exist would be worse than
-- admitting there is none.
-- ───────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO "settings"."LetterKindField"
  ("id", "letterKindId", "token", "label", "sourceType", "sourcePath", "isRequired", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  k."id",
  f."token",
  f."label",
  f."sourceType"::"settings"."LetterFieldSource",
  f."sourcePath",
  f."isRequired",
  NOW(),
  NOW()
FROM "settings"."LetterKind" k
JOIN (
  VALUES
    -- offer
    ('offer', 'candidateName',   'Candidate name',    'candidate', 'fullName',          true),
    ('offer', 'designation',      'Designation',       'employee',  'designation.name',  true),
    ('offer', 'department',       'Department',        'employee',  'department.name',   false),
    ('offer', 'offeredCtc',       'Offered CTC',       'manual',    NULL,                true),
    ('offer', 'joiningDate',      'Joining date',      'manual',    NULL,                true),
    ('offer', 'probationMonths',  'Probation months',  'manual',    NULL,                false),
    ('offer', 'noticePeriodDays', 'Notice period days','manual',    NULL,                false),
    ('offer', 'companyName',      'Company name',      'company',   'name',              true),
    ('offer', 'issueDate',        'Issue date',        'manual',    NULL,                true),
    -- appointment
    ('appointment', 'employeeName',      'Employee name',      'employee', 'firstName',        true),
    ('appointment', 'employeeCode',      'Employee code',      'employee', 'employeeCode',     true),
    ('appointment', 'designation',       'Designation',        'employee', 'designation.name', true),
    ('appointment', 'department',        'Department',         'employee', 'department.name',  false),
    ('appointment', 'dateOfJoining',     'Date of joining',    'employee', 'dateOfJoining',    true),
    ('appointment', 'reportingManager',  'Reporting manager',  'manual',   NULL,               false),
    ('appointment', 'companyName',       'Company name',       'company',  'name',             true),
    ('appointment', 'issueDate',         'Issue date',         'manual',   NULL,               true),
    -- confirmation
    ('confirmation', 'employeeName',     'Employee name',      'employee', 'firstName',        true),
    ('confirmation', 'employeeCode',     'Employee code',      'employee', 'employeeCode',     true),
    ('confirmation', 'designation',      'Designation',        'employee', 'designation.name', true),
    ('confirmation', 'confirmationDate', 'Confirmation date',  'employee', 'confirmationDate', true),
    ('confirmation', 'companyName',      'Company name',       'company',  'name',             true),
    ('confirmation', 'issueDate',        'Issue date',         'manual',   NULL,               true),
    -- relieving
    ('relieving', 'employeeName',    'Employee name',     'employee', 'firstName',        true),
    ('relieving', 'employeeCode',    'Employee code',     'employee', 'employeeCode',     true),
    ('relieving', 'designation',     'Designation',       'employee', 'designation.name', true),
    ('relieving', 'dateOfJoining',   'Date of joining',   'employee', 'dateOfJoining',    true),
    ('relieving', 'lastWorkingDay',  'Last working day',  'manual',   NULL,               true),
    ('relieving', 'companyName',     'Company name',      'company',  'name',             true),
    ('relieving', 'issueDate',       'Issue date',        'manual',   NULL,               true),
    -- experience
    ('experience', 'employeeName',   'Employee name',     'employee', 'firstName',        true),
    ('experience', 'employeeCode',   'Employee code',     'employee', 'employeeCode',     true),
    ('experience', 'designation',    'Designation',       'employee', 'designation.name', true),
    ('experience', 'dateOfJoining',  'Date of joining',   'employee', 'dateOfJoining',    true),
    ('experience', 'lastWorkingDay', 'Last working day',  'manual',   NULL,               true),
    ('experience', 'tenure',         'Tenure',            'manual',   NULL,               false),
    ('experience', 'companyName',    'Company name',      'company',  'name',             true),
    ('experience', 'issueDate',      'Issue date',        'manual',   NULL,               true)
) AS f("kindKey", "token", "label", "sourceType", "sourcePath", "isRequired")
  ON f."kindKey" = k."key"
ON CONFLICT ("letterKindId", "token") DO NOTHING;
