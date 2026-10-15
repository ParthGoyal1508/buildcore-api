-- Uploaded No Objection Certificates (2026-10-15): after a work order or an LOI, on a vehicle hire
-- order, and for a labour worker, a vendor or a member of staff. Not generated, so not numbered.

CREATE TABLE "shared"."NocDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "stage" TEXT,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "issuedBy" TEXT,
    "referenceNo" TEXT,
    "issuedOn" DATE,
    "remarks" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NocDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NocDocument_companyId_subjectType_subjectId_idx" ON "shared"."NocDocument"("companyId", "subjectType", "subjectId");

ALTER TABLE "shared"."NocDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."NocDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."NocDocument"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
