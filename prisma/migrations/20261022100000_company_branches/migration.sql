-- 041 company branches (2026-10-22): one row per GST registration of a company. Parth Realcon is
-- registered in five states and Tirupati Enterprises in seven; each registration has its own GSTIN,
-- address and (for TE) PF establishment code, while legal name, PAN, CIN and TAN stay on Company.
--
-- Every existing company gets exactly one branch, its head office, copied from the Company columns
-- it already has. Those columns stay and mirror the head office from now on (research R2).

-- Production migrates through a role subject to FORCE ROW LEVEL SECURITY; the backfill below must
-- pass the new table's tenant policy there, not only as the local superuser.
SELECT set_config('app.is_super_admin', 'true', true);

CREATE TABLE "settings"."CompanyBranch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT,
    "tradeName" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pinCode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "pfEstablishmentCode" TEXT,
    "esicCode" TEXT,
    "professionalTaxRegNumber" TEXT,
    "isHeadOffice" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyBranch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompanyBranch_companyId_idx" ON "settings"."CompanyBranch"("companyId");

-- Partial, because @@unique treats every NULL as distinct: one head office per company, and one
-- GSTIN per company when a branch has one (an unregistered head office has none).
CREATE UNIQUE INDEX "CompanyBranch_one_head_office" ON "settings"."CompanyBranch"("companyId")
  WHERE "isHeadOffice";
CREATE UNIQUE INDEX "CompanyBranch_companyId_gstin_key" ON "settings"."CompanyBranch"("companyId", "gstin")
  WHERE "gstin" IS NOT NULL;

ALTER TABLE "settings"."CompanyBranch" ADD CONSTRAINT "CompanyBranch_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "settings"."CompanyBranch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."CompanyBranch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."CompanyBranch"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- The head office of every company, from what the company already records. Guarded so a re-run
-- (or a seed that already made one) never adds a second.
INSERT INTO "settings"."CompanyBranch" (
  "id", "companyId", "gstin", "address", "city", "state", "pinCode", "phone", "email", "website",
  "pfEstablishmentCode", "esicCode", "professionalTaxRegNumber", "isHeadOffice", "isActive", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", NULLIF(c."gstin", ''), c."address", c."city", c."state",
       c."pinCode", c."phone", c."email", c."website", c."pfEstablishmentCode", c."esicCode",
       c."professionalTaxRegNumber", true, true, CURRENT_TIMESTAMP
FROM "settings"."Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "settings"."CompanyBranch" b WHERE b."companyId" = c."id" AND b."isHeadOffice"
);
