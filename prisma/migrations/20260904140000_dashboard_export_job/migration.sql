-- Dashboard & General (feature 004, US7): the single `shared.ExportJob` tracking
-- table, its two enums, and the REPORT_EXPORT audit entity type. Dashboard owns no
-- business schema — this table lives in `shared` alongside AuditLogEntry
-- (research.md §3). RLS follows the session-variable pattern set by
-- 20260829073000_settings_rls_policies and every feature since.

-- CreateEnum
CREATE TYPE "shared"."ExportFormat" AS ENUM ('pdf', 'excel');
CREATE TYPE "shared"."ExportJobStatus" AS ENUM ('pending', 'processing', 'ready', 'failed');

-- AlterEnum
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'REPORT_EXPORT';

-- CreateTable
CREATE TABLE "shared"."ExportJob" (
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "format" "shared"."ExportFormat" NOT NULL,
    "filters" JSONB NOT NULL,
    "status" "shared"."ExportJobStatus" NOT NULL DEFAULT 'pending',
    "requestedByUserId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fileRef" TEXT,
    "failureReason" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportJob_companyId_status_idx" ON "shared"."ExportJob"("companyId", "status");

-- Row-level security (Constitution Principle IV)
ALTER TABLE "shared"."ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ExportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ExportJob"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
