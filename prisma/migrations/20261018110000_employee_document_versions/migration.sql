-- 036 F15: employee documents keep what they replace, and record what the file is.
--
-- Replacing a document used to delete its old file for good. The current upload stays on
-- "EmployeeDocument" (one per type — the mandatory-document gate counts those) and each replaced
-- one now moves to "EmployeeDocumentVersion" with its file. The three metadata columns are null
-- on documents filed before them; the file endpoint sniffs the type for those.

-- AlterTable
ALTER TABLE "hr"."EmployeeDocument" ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "sizeBytes" INTEGER;

-- CreateTable
CREATE TABLE "hr"."EmployeeDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "documentNumber" TEXT,
    "expiresAt" DATE,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "replacedByUserId" TEXT NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeDocumentVersion_documentId_idx" ON "hr"."EmployeeDocumentVersion"("documentId");

-- CreateIndex
CREATE INDEX "EmployeeDocumentVersion_employeeId_idx" ON "hr"."EmployeeDocumentVersion"("employeeId");

-- AddForeignKey
ALTER TABLE "hr"."EmployeeDocumentVersion" ADD CONSTRAINT "EmployeeDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "hr"."EmployeeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: scoped through the owning employee, verbatim the "EmployeeDocument" rule
-- (20260901193400_hr_payroll_rls_policies).
ALTER TABLE "hr"."EmployeeDocumentVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."EmployeeDocumentVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."EmployeeDocumentVersion"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."EmployeeDocumentVersion"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );
