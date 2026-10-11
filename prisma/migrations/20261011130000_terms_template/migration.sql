-- CreateEnum
CREATE TYPE "settings"."TermsDocumentKind" AS ENUM ('work_order', 'letter_of_intent', 'purchase_order');

-- CreateTable
CREATE TABLE "settings"."TermsTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentKind" "settings"."TermsDocumentKind" NOT NULL,
    "body" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TermsTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TermsTemplate_companyId_idx" ON "settings"."TermsTemplate"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "TermsTemplate_companyId_documentKind_key" ON "settings"."TermsTemplate"("companyId", "documentKind");

-- AddForeignKey
ALTER TABLE "settings"."TermsTemplate" ADD CONSTRAINT "TermsTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation. Every new table gets this (Constitution, multi-tenant isolation), and
-- `terms-template-rls.e2e-spec.ts` proves it against a real connection rather than against
-- the presence of these lines.
--
-- `FORCE`, like every other policy in this product: without it the table's owner — which is
-- the role the application connects as — is exempt, and the policy would protect nothing in
-- the only context that matters.
ALTER TABLE "settings"."TermsTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."TermsTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."TermsTemplate"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
