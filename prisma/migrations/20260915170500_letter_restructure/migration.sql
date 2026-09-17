-- ════════════════════════════════════════════════════════════════════════════════
-- 017 Phase 5 — the letter restructure
--
-- `enum LetterType` becomes a `LetterKind` table, and `recruitment.GeneratedLetter`
-- moves to `shared` and becomes `IssuedLetter`.
--
-- HAND-AUTHORED, and ONE file rather than several, deliberately. Prisma wanted to DROP
-- the populated table and refused to add a required column to it (research §1). More to
-- the point, Postgres runs one migration file in one transaction: a half-applied
-- sequence is the failure mode worth designing against, and splitting these steps across
-- files is what would create it. Either every step below lands or none does.
--
-- The steps are ordered, and the order is the content. Read them top to bottom.
-- ════════════════════════════════════════════════════════════════════════════════

-- ─── Step 1: the kinds table ────────────────────────────────────────────────────
CREATE TABLE "settings"."LetterKind" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requiresSignature" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalActionType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LetterKind_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LetterKind_companyId_idx" ON "settings"."LetterKind"("companyId");
CREATE UNIQUE INDEX "LetterKind_companyId_key_key" ON "settings"."LetterKind"("companyId", "key");

-- The composite unique above is NOT enough on its own, and this is the defect the
-- migration checklist caught (CHK014). Postgres treats NULLs as DISTINCT in a unique
-- index, so `(NULL, 'offer')` could be inserted twice — two product-shipped kinds
-- sharing a key, which would leave Step 4's backfill with two candidate rows to match
-- and no stated precedence between them.
CREATE UNIQUE INDEX "LetterKind_shipped_key" ON "settings"."LetterKind"("key")
  WHERE "companyId" IS NULL;

ALTER TABLE "settings"."LetterKind"
  ADD CONSTRAINT "LetterKind_companyId_fkey" FOREIGN KEY ("companyId")
  REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Step 2: signatories ────────────────────────────────────────────────────────
CREATE TABLE "settings"."Signatory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "signatureRef" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Signatory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Signatory_companyId_idx" ON "settings"."Signatory"("companyId");

ALTER TABLE "settings"."Signatory"
  ADD CONSTRAINT "Signatory_companyId_fkey" FOREIGN KEY ("companyId")
  REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Step 3: seed the fifteen product kinds ─────────────────────────────────────
--
-- IN THE MIGRATION, not in `prisma/seed.ts` (research §7). Step 4's backfill depends on
-- these rows existing, and `seed.ts` wipes data and must never run against production —
-- a backfill that depends on it would be a backfill that cannot be deployed.
--
-- Ids are literal and deterministic rather than generated, which is what makes this
-- re-appliable: running it twice inserts nothing the second time.
--
-- THE FIRST FIVE KEYS ARE BYTE-IDENTICAL TO THE OLD ENUM VALUES. That is not a
-- convenience; it is the entire basis on which Step 4 matches existing rows, and
-- changing one of these strings breaks the migration for every installation that has
-- not yet run it.
--
-- `requiresSignature` is FALSE for the five migrated kinds on purpose: no signature is
-- applied to them today, and turning it on here would change what Recruitment renders —
-- which is precisely what T035 exists to forbid. The three commercial kinds are
-- signature-bearing because an unsigned work order is not a work order.
INSERT INTO "settings"."LetterKind"
  ("id", "companyId", "key", "label", "requiresSignature", "requiresApproval", "approvalActionType", "isActive", "createdAt", "updatedAt")
VALUES
  ('ltrkind_offer',              NULL, 'offer',                'Offer letter',              false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_appointment',        NULL, 'appointment',          'Appointment letter',        false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_confirmation',       NULL, 'confirmation',         'Confirmation letter',       false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_relieving',          NULL, 'relieving',            'Relieving letter',          false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_experience',         NULL, 'experience',           'Experience letter',         false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_transfer',           NULL, 'transfer',             'Transfer letter',           true,  false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_suspension',         NULL, 'suspension',           'Suspension letter',         true,  false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_salary_slip',        NULL, 'salary_slip',          'Salary slip',               false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_work_order',         NULL, 'letter_work_order',    'Work order',                true,  true,  'letter_work_order',      true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_loi',                NULL, 'letter_loi',           'Letter of intent',          true,  true,  'letter_loi',             true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_purchase_order',     NULL, 'letter_purchase_order','Purchase order',            true,  true,  'letter_purchase_order',  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_indent',             NULL, 'indent',               'Indent',                    false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_service_order',      NULL, 'service_order',        'Service order',             true,  false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_service_bill',       NULL, 'service_bill',         'Service bill',              false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_maintenance_bill',   NULL, 'maintenance_bill',     'Maintenance bill',          false, false, NULL,                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") WHERE "companyId" IS NULL DO NOTHING;

-- ─── Step 4: nullable column, then backfill, then NOT NULL ──────────────────────
--
-- Nullable first because Prisma cannot add a required column to a populated table and
-- neither can Postgres without a default — and a default here would be a lie, since the
-- correct value differs per row.
ALTER TABLE "settings"."LetterTemplate"     ADD COLUMN "letterKindId" TEXT;
ALTER TABLE "recruitment"."GeneratedLetter" ADD COLUMN "letterKindId" TEXT;

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

UPDATE "settings"."LetterTemplate" t
   SET "letterKindId" = k."id"
  FROM "settings"."LetterKind" k
 WHERE k."companyId" IS NULL
   AND k."key" = t."letterType"::text;

UPDATE "recruitment"."GeneratedLetter" g
   SET "letterKindId" = k."id"
  FROM "settings"."LetterKind" k
 WHERE k."companyId" IS NULL
   AND k."key" = g."letterType"::text;

-- The backfill's failure mode, stated rather than assumed (the migration checklist asked
-- for exactly this). An unmatched row means a `letterType` value with no seeded key —
-- which can only happen if somebody edited the enum without editing Step 3. Aborting
-- rolls the whole transaction back and leaves a comprehensible message; a silent NULL
-- would fail three statements later as an unexplained NOT NULL violation.
DO $$
DECLARE unmatched INT;
BEGIN
  SELECT count(*) INTO unmatched FROM "settings"."LetterTemplate" WHERE "letterKindId" IS NULL;
  IF unmatched > 0 THEN
    RAISE EXCEPTION 'Letter restructure aborted: % LetterTemplate row(s) have a letterType with no matching seeded LetterKind key. Seed the missing kind in Step 3 and re-run.', unmatched;
  END IF;

  SELECT count(*) INTO unmatched FROM "recruitment"."GeneratedLetter" WHERE "letterKindId" IS NULL;
  IF unmatched > 0 THEN
    RAISE EXCEPTION 'Letter restructure aborted: % GeneratedLetter row(s) have a letterType with no matching seeded LetterKind key. Seed the missing kind in Step 3 and re-run.', unmatched;
  END IF;
END $$;

ALTER TABLE "settings"."LetterTemplate"     ALTER COLUMN "letterKindId" SET NOT NULL;
ALTER TABLE "recruitment"."GeneratedLetter" ALTER COLUMN "letterKindId" SET NOT NULL;

-- `Restrict`, so FR-022 — refuse to delete a kind while letters reference it — is the
-- database's guarantee. The service check that produces the readable 409 is a message,
-- not the enforcement.
ALTER TABLE "settings"."LetterTemplate"
  ADD CONSTRAINT "LetterTemplate_letterKindId_fkey" FOREIGN KEY ("letterKindId")
  REFERENCES "settings"."LetterKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Step 5: drop the enum column and the enum ──────────────────────────────────
DROP INDEX "settings"."LetterTemplate_companyId_letterType_idx";
DROP INDEX "recruitment"."GeneratedLetter_companyId_letterType_employeeId_idx";
DROP INDEX "recruitment"."GeneratedLetter_companyId_letterType_candidateId_idx";

ALTER TABLE "settings"."LetterTemplate"     DROP COLUMN "letterType";
ALTER TABLE "recruitment"."GeneratedLetter" DROP COLUMN "letterType";

DROP TYPE "settings"."LetterType";

CREATE INDEX "LetterTemplate_companyId_letterKindId_idx"
  ON "settings"."LetterTemplate"("companyId", "letterKindId");

-- ─── Step 6: the move, and the rename ───────────────────────────────────────────
--
-- The riskiest two statements in the feature. `SET SCHEMA` carries the table's data,
-- indexes, constraints, RLS policies and the ENABLE/FORCE flags with it — the row-level
-- security on this table is NOT re-created below because it was never lost.
ALTER TABLE "recruitment"."GeneratedLetter" SET SCHEMA "shared";
ALTER TABLE "shared"."GeneratedLetter" RENAME TO "IssuedLetter";

-- Postgres keeps the old names for everything attached to a renamed table. Renaming them
-- is not cosmetic: Prisma derives expected constraint and index names from the model, and
-- a mismatch shows up as permanent phantom drift in every later `migrate dev`.
ALTER TABLE "shared"."IssuedLetter" RENAME CONSTRAINT "GeneratedLetter_pkey" TO "IssuedLetter_pkey";
ALTER INDEX "shared"."GeneratedLetter_companyId_idx" RENAME TO "IssuedLetter_companyId_idx";

-- ─── Step 7: the columns the move exists to make possible ───────────────────────
ALTER TABLE "shared"."IssuedLetter"
  ADD COLUMN "subjectType"         TEXT,
  ADD COLUMN "subjectId"           TEXT,
  ADD COLUMN "signatoryId"         TEXT,
  ADD COLUMN "appliedSignatureRef" TEXT,
  ADD COLUMN "countersignedRef"    TEXT,
  ADD COLUMN "countersignedAt"     TIMESTAMP(3),
  ADD COLUMN "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- NULL `issuedAt` means composed but not yet issued. A gated kind must clear its 016
-- chain before it takes effect, and a chain needs something to be raised against — so the
-- letter row exists first and is issued second. Every existing row keeps its timestamp,
-- so nothing already issued becomes a draft.
ALTER TABLE "shared"."IssuedLetter" ALTER COLUMN "issuedAt"    DROP NOT NULL;
ALTER TABLE "shared"."IssuedLetter" ALTER COLUMN "renderedRef" SET DEFAULT '';

CREATE INDEX "IssuedLetter_companyId_letterKindId_employeeId_idx"
  ON "shared"."IssuedLetter"("companyId", "letterKindId", "employeeId");
CREATE INDEX "IssuedLetter_companyId_letterKindId_candidateId_idx"
  ON "shared"."IssuedLetter"("companyId", "letterKindId", "candidateId");
CREATE INDEX "IssuedLetter_companyId_subjectType_subjectId_idx"
  ON "shared"."IssuedLetter"("companyId", "subjectType", "subjectId");

ALTER TABLE "shared"."IssuedLetter"
  ADD CONSTRAINT "IssuedLetter_companyId_fkey" FOREIGN KEY ("companyId")
  REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared"."IssuedLetter"
  ADD CONSTRAINT "IssuedLetter_letterKindId_fkey" FOREIGN KEY ("letterKindId")
  REFERENCES "settings"."LetterKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shared"."IssuedLetter"
  ADD CONSTRAINT "IssuedLetter_signatoryId_fkey" FOREIGN KEY ("signatoryId")
  REFERENCES "settings"."Signatory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Step 8: exactly one addressing form ────────────────────────────────────────
--
-- Checked against the rows that already exist BEFORE the constraint is added. The
-- migration checklist asked what happens if an existing row violates it, and the honest
-- answer has to be an abort with a message rather than a constraint-violation stack
-- trace from somewhere inside `ALTER TABLE`.
DO $$
DECLARE violating INT;
BEGIN
  SELECT count(*) INTO violating FROM "shared"."IssuedLetter"
   WHERE NOT (
     (("employeeId" IS NOT NULL OR "candidateId" IS NOT NULL) AND "subjectId" IS NULL)
     OR (("employeeId" IS NULL AND "candidateId" IS NULL) AND "subjectId" IS NOT NULL)
   );
  IF violating > 0 THEN
    RAISE EXCEPTION 'Letter restructure aborted: % existing letter(s) address nobody. Every row must name an employee, a candidate, or an opaque subject before the constraint can be added.', violating;
  END IF;
END $$;

ALTER TABLE "shared"."IssuedLetter"
  ADD CONSTRAINT "IssuedLetter_one_addressing_form" CHECK (
    (("employeeId" IS NOT NULL OR "candidateId" IS NOT NULL) AND "subjectId" IS NULL)
    OR (("employeeId" IS NULL AND "candidateId" IS NULL) AND "subjectId" IS NOT NULL)
  );

-- ─── Step 9: row-level security on the two new tables ───────────────────────────
--
-- FORCE matters: without it the table owner bypasses its own policy, which is how a
-- tenant-isolation test passes while isolating nothing.
ALTER TABLE "settings"."LetterKind" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."LetterKind" FORCE  ROW LEVEL SECURITY;

-- The `ReminderRule` variant: product-shipped kinds belong to no company and must be
-- visible to every company, so `companyId IS NULL` is admitted alongside the tenant match.
CREATE POLICY "tenant_isolation" ON "settings"."LetterKind"
  USING (
    "companyId" IS NULL
    OR "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."Signatory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."Signatory" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "settings"."Signatory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- The old table defaulted `issuedAt` to now(). With NULL now meaning "composed, not yet
-- issued", a default would quietly issue every draft at the moment it was created —
-- which is the exact state the approval gate exists to prevent.
ALTER TABLE "shared"."IssuedLetter" ALTER COLUMN "issuedAt" DROP DEFAULT;
