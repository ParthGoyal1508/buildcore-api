-- 037 Bank Guarantees (specs/037-bank-guarantees/spec.md): a tender, its EMD and PBG guarantees,
-- their documents and their history.

-- CreateEnum
CREATE TYPE "projects"."BankGuaranteeType" AS ENUM ('EMD', 'PBG');

-- CreateEnum
CREATE TYPE "projects"."BankGuaranteeStatus" AS ENUM ('RUNNING', 'RELEASED', 'ENCASHED');

-- CreateTable
CREATE TABLE "projects"."BgTender" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serialNo" INTEGER NOT NULL,
    "workName" TEXT NOT NULL,
    "departmentName" TEXT NOT NULL,
    "tenderAmount" DECIMAL(16,2),
    "projectId" TEXT,
    "remarks" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgTender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BankGuarantee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "type" "projects"."BankGuaranteeType" NOT NULL,
    "bgNumber" TEXT,
    "amount" DECIMAL(16,2) NOT NULL,
    "issueDate" DATE,
    "expiryDate" DATE,
    "claimPeriodEndDate" DATE,
    "issuingBank" TEXT,
    "issuingBranch" TEXT,
    "marginAmount" DECIMAL(16,2),
    "fdReference" TEXT,
    "status" "projects"."BankGuaranteeStatus" NOT NULL DEFAULT 'RUNNING',
    "releasedOn" DATE,
    "encashedOn" DATE,
    "encashedAmount" DECIMAL(16,2),
    "remarks" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankGuarantee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BankGuaranteeDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankGuaranteeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankGuaranteeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BankGuaranteeEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankGuaranteeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromDate" DATE,
    "toDate" DATE,
    "note" TEXT,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankGuaranteeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BgTender_companyId_idx" ON "projects"."BgTender"("companyId");

-- CreateIndex
CREATE INDEX "BgTender_projectId_idx" ON "projects"."BgTender"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BgTender_companyId_serialNo_key" ON "projects"."BgTender"("companyId", "serialNo");

-- CreateIndex
CREATE INDEX "BankGuarantee_companyId_idx" ON "projects"."BankGuarantee"("companyId");

-- CreateIndex
CREATE INDEX "BankGuarantee_tenderId_idx" ON "projects"."BankGuarantee"("tenderId");

-- CreateIndex
CREATE INDEX "BankGuarantee_companyId_status_expiryDate_idx" ON "projects"."BankGuarantee"("companyId", "status", "expiryDate");

-- CreateIndex
CREATE INDEX "BankGuaranteeDocument_companyId_idx" ON "projects"."BankGuaranteeDocument"("companyId");

-- CreateIndex
CREATE INDEX "BankGuaranteeDocument_bankGuaranteeId_idx" ON "projects"."BankGuaranteeDocument"("bankGuaranteeId");

-- CreateIndex
CREATE INDEX "BankGuaranteeEvent_bankGuaranteeId_idx" ON "projects"."BankGuaranteeEvent"("bankGuaranteeId");

-- CreateIndex
CREATE INDEX "BankGuaranteeEvent_companyId_idx" ON "projects"."BankGuaranteeEvent"("companyId");

-- AddForeignKey
ALTER TABLE "projects"."BgTender" ADD CONSTRAINT "BgTender_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BankGuarantee" ADD CONSTRAINT "BankGuarantee_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "projects"."BgTender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BankGuaranteeDocument" ADD CONSTRAINT "BankGuaranteeDocument_bankGuaranteeId_fkey" FOREIGN KEY ("bankGuaranteeId") REFERENCES "projects"."BankGuarantee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BankGuaranteeEvent" ADD CONSTRAINT "BankGuaranteeEvent_bankGuaranteeId_fkey" FOREIGN KEY ("bankGuaranteeId") REFERENCES "projects"."BankGuarantee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A BG number names one instrument. Partial, because a guarantee applied for but not yet issued
-- has no number yet, and any number of those may exist.
CREATE UNIQUE INDEX "BankGuarantee_companyId_bgNumber_key"
  ON "projects"."BankGuarantee"("companyId", "bgNumber") WHERE "bgNumber" IS NOT NULL;

-- The standard tenant policy every projects table carries.
ALTER TABLE "projects"."BgTender" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BgTender" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BgTender"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."BankGuarantee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BankGuarantee" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BankGuarantee"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."BankGuaranteeDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BankGuaranteeDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BankGuaranteeDocument"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."BankGuaranteeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BankGuaranteeEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BankGuaranteeEvent"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- BANK_GUARANTEES for Super Admin only. It is a new register with no holders to keep whole; who
-- else keeps the BG register, and so receives its expiry alerts, is a Settings → Roles decision.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'BANK_GUARANTEES'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261020100001_bank_guarantees'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" = 'Super Admin'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- The legacy array (019 phase 2 still reads it for roles without level rows).
UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'BANK_GUARANTEES'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" = 'Super Admin'
  AND NOT ('BANK_GUARANTEES' = ANY (r."permissions"));
