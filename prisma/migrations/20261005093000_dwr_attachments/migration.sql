-- CreateTable
CREATE TABLE "projects"."DWRAttachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dwrId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DWRAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DWRAttachment_companyId_idx" ON "projects"."DWRAttachment"("companyId");

-- CreateIndex
CREATE INDEX "DWRAttachment_dwrId_idx" ON "projects"."DWRAttachment"("dwrId");

-- AddForeignKey
ALTER TABLE "projects"."DWRAttachment" ADD CONSTRAINT "DWRAttachment_dwrId_fkey" FOREIGN KEY ("dwrId") REFERENCES "projects"."DailyWorkReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, in the identical form every other tenant-scoped table in this schema
-- carries. Appended rather than generated because Prisma does not emit policies (022 FR-040).
--
-- Worth saying plainly where it will be read: this policy is **not evidence of isolation on its
-- own**. The development and continuous-integration role is a superuser, and Postgres exempts a
-- superuser from row-level security unconditionally — so a policy written here has never once been
-- in force in a test run. `test/dwr-rls.e2e-spec.ts` creates a NOSUPERUSER NOBYPASSRLS role and
-- exercises it, and that suite is what makes this statement mean something. 148 tables in this
-- database carry this policy and about 21 are named in a probe suite; that gap is what let a
-- 42501 reach production on 2026-10-04.
ALTER TABLE "projects"."DWRAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."DWRAttachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."DWRAttachment"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
