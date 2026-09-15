-- AlterTable
ALTER TABLE "settings"."DocumentType" ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "settings"."CompanyDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "documentNumber" TEXT,
    "expiresAt" DATE,
    "supersedesId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."ProjectDocumentRequirement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDocumentRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDocument_supersedesId_key" ON "settings"."CompanyDocument"("supersedesId");

-- CreateIndex
CREATE INDEX "CompanyDocument_companyId_idx" ON "settings"."CompanyDocument"("companyId");

-- CreateIndex
CREATE INDEX "CompanyDocument_expiresAt_idx" ON "settings"."CompanyDocument"("expiresAt");

-- CreateIndex
CREATE INDEX "ProjectDocumentRequirement_companyId_idx" ON "projects"."ProjectDocumentRequirement"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocumentRequirement_companyId_documentTypeId_key" ON "projects"."ProjectDocumentRequirement"("companyId", "documentTypeId");

-- AddForeignKey
ALTER TABLE "settings"."CompanyDocument" ADD CONSTRAINT "CompanyDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."CompanyDocument" ADD CONSTRAINT "CompanyDocument_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "settings"."DocumentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."CompanyDocument" ADD CONSTRAINT "CompanyDocument_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "settings"."CompanyDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ══════════════════════════════════════════════════════════════════════════════
-- Hand-authored below this line. Prisma can express none of it.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 017 T008: exactly one CURRENT document per company per kind ───────────────
--
-- A plain @@unique([companyId, documentTypeId]) would make FR-006 impossible: uploading a
-- renewed GST certificate would have to delete the old one rather than retain it. The
-- predicate is what lets the history stack behind the live row.
--
-- Predicated on a state column rather than on the supersession pointer, deliberately.
-- "Current means nothing points at this row" cannot be indexed — it needs a NOT EXISTS.
-- A forward pointer can be indexed but creates a chicken-and-egg on insert: the new row
-- cannot be current until the old one is not, and the old one cannot point at a row that
-- does not exist yet. A flag has neither problem, and it is the same shape 016 used to
-- guarantee one live approval instance per item.
--
-- At the database level on purpose. A service-level "is there already a current one?"
-- check passes a single-threaded test and loses the race two concurrent uploads create.
CREATE UNIQUE INDEX "CompanyDocument_current_per_kind"
  ON "settings"."CompanyDocument" ("companyId", "documentTypeId")
  WHERE "isCurrent";

-- ── 017 T007: row-level security (Constitution Principle IV) ──────────────────
--
-- Same session-variable pattern as every feature since 001, set by
-- src/common/prisma/rls-context.ts. FORCE, not merely ENABLE: without it the table owner
-- bypasses its own policy, which is the difference between a policy that is written and
-- one that is in effect.
ALTER TABLE "settings"."CompanyDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."CompanyDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."CompanyDocument"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."ProjectDocumentRequirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ProjectDocumentRequirement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ProjectDocumentRequirement"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── 017 T004: mark Aadhaar restricted, idempotently (FR-024, CHK029) ──────────
--
-- Guarded rather than unconditional: re-applying this migration must not flip back a
-- change an operator made later. Matched on `code` because DocumentType is per-company.
UPDATE "settings"."DocumentType"
   SET "isRestricted" = true
 WHERE upper("code") IN ('AADHAAR', 'AADHAR', 'UID')
   AND "isRestricted" = false;
