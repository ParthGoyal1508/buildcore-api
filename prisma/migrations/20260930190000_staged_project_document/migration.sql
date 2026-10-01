-- 017 Phase 13, 2026-09-30. Documents staged before the project exists (FR-009b).
--
-- This table is the cost of the word "cannot". FR-009 says no project is created while a mandatory
-- kind has no document attached, so the documents have to exist before the project does — and there
-- is nowhere to hang them until it is created.
--
-- Additive, no backfill, no data statement, so no `set_config` guard. Said rather than omitted
-- silently: that line belongs where a data statement exists and nowhere else, or it becomes a
-- ritual rather than a decision.

CREATE TABLE "projects"."StagedProjectDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentTypeId" TEXT,
    "documentType" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "filePath" TEXT,
    -- An authorisation input, not attribution: project creation refuses a staged id whose
    -- uploader is not the calling user, and refuses it with the same code as a nonexistent id so
    -- the refusal cannot be used to discover another user's staged document (FR-009c).
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedProjectDocument_pkey" PRIMARY KEY ("id")
);

-- `createdAt` in the index because the sweep's predicate is an age, and it runs over every
-- company's rows at once.
CREATE INDEX "StagedProjectDocument_companyId_createdAt_idx"
  ON "projects"."StagedProjectDocument"("companyId", "createdAt");

-- Tenant isolation, WITH CHECK written explicitly rather than left to default from USING:
-- Postgres reuses USING when WITH CHECK is omitted, which works but means a later edit to one
-- silently changes the other.
--
-- Note that RLS is not what stops user B consuming user A's staged document — both are in the same
-- company, so the policy admits both. That check is `uploadedBy` in the service, which is why the
-- column's comment calls it an authorisation input. A policy here would be the wrong tool for a
-- question about users rather than tenants.
ALTER TABLE "projects"."StagedProjectDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."StagedProjectDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."StagedProjectDocument"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
