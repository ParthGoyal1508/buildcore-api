-- HR documents, 2026-10-13: the client's HR_DOCS set generated from the records already held.
--
-- Additive. Father's name and a candidate's postal address are what every HR letter prints under
-- the addressee and nothing stored them. A salary revision is the dated record an increment letter
-- states. Two shipped kinds join the HR set: termination and the full & final settlement sheet.

ALTER TABLE "hr"."Employee" ADD COLUMN "fatherName" TEXT;
ALTER TABLE "recruitment"."Candidate" ADD COLUMN "fatherName" TEXT;
ALTER TABLE "recruitment"."Candidate" ADD COLUMN "address" TEXT;

CREATE TABLE "hr"."SalaryRevision" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "previousBasic" DECIMAL(12,2),
    "previousHra" DECIMAL(12,2),
    "previousConveyance" DECIMAL(12,2),
    "previousSiteAllowance" DECIMAL(12,2),
    "previousSpecialAllowance" DECIMAL(12,2),
    "basic" DECIMAL(12,2),
    "hra" DECIMAL(12,2),
    "conveyance" DECIMAL(12,2),
    "siteAllowance" DECIMAL(12,2),
    "specialAllowance" DECIMAL(12,2),
    "remarks" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalaryRevision_companyId_idx" ON "hr"."SalaryRevision"("companyId");
CREATE INDEX "SalaryRevision_employeeId_effectiveFrom_idx"
  ON "hr"."SalaryRevision"("employeeId", "effectiveFrom");

ALTER TABLE "hr"."SalaryRevision"
  ADD CONSTRAINT "SalaryRevision_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's pay. WITH CHECK written explicitly, as everywhere else in this schema.
ALTER TABLE "hr"."SalaryRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."SalaryRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."SalaryRevision"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- Termination is signed (the client's draft closes "For <company>, HR Department"). The F&F sheet
-- carries its own Prepared/Approved/Employee signature boxes, so no graphic is applied to it.
INSERT INTO "settings"."LetterKind"
  ("id", "companyId", "key", "label", "requiresSignature", "requiresApproval", "approvalActionType", "isActive", "createdAt", "updatedAt")
VALUES
  ('ltrkind_termination',    NULL, 'termination',    'Termination letter',                   true,  false, NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_fnf_settlement', NULL, 'fnf_settlement', 'Full & final (F&F) settlement sheet',  false, false, NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") WHERE "companyId" IS NULL DO NOTHING;
