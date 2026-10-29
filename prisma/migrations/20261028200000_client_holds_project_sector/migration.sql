-- CreateEnum
CREATE TYPE "projects"."ProjectSector" AS ENUM ('government', 'private');

-- CreateEnum
CREATE TYPE "projects"."ClientHoldKind" AS ENUM ('retention', 'cpbg');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CLIENT_RECEIPT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CLIENT_HOLD_RELEASE';

-- AlterTable
ALTER TABLE "projects"."Project" ADD COLUMN     "clientCpbgFraction" DECIMAL(8,6),
ADD COLUMN     "sector" "projects"."ProjectSector";

-- AlterTable
ALTER TABLE "projects"."ProjectDocumentRequirement" ADD COLUMN     "forGovernment" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "forPrivate" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "projects"."ClientBillReceipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientBillId" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "retentionAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cpbgAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherDeductionNote" TEXT,
    "instrument" "projects"."PaymentInstrument" NOT NULL,
    "reference" TEXT,
    "remarks" TEXT,
    "recordedByUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientBillReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."ClientHoldRelease" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "projects"."ClientHoldKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "releasedOn" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "bankGuaranteeId" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientHoldRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientBillReceipt_companyId_projectId_idx" ON "projects"."ClientBillReceipt"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "ClientBillReceipt_clientBillId_idx" ON "projects"."ClientBillReceipt"("clientBillId");

-- CreateIndex
CREATE INDEX "ClientHoldRelease_companyId_projectId_idx" ON "projects"."ClientHoldRelease"("companyId", "projectId");

-- AddForeignKey
ALTER TABLE "projects"."ClientBillReceipt" ADD CONSTRAINT "ClientBillReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."ClientBillReceipt" ADD CONSTRAINT "ClientBillReceipt_clientBillId_fkey" FOREIGN KEY ("clientBillId") REFERENCES "projects"."ClientBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."ClientHoldRelease" ADD CONSTRAINT "ClientHoldRelease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."ClientHoldRelease" ADD CONSTRAINT "ClientHoldRelease_bankGuaranteeId_fkey" FOREIGN KEY ("bankGuaranteeId") REFERENCES "projects"."BankGuarantee"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The standard tenant policy every projects table carries.
ALTER TABLE "projects"."ClientBillReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ClientBillReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ClientBillReceipt"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."ClientHoldRelease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ClientHoldRelease" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ClientHoldRelease"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- Project type from the free text the data loads used (048). "Government" / "Private" (and the
-- common spellings) were written into `departmentType`, occasionally `projectType`; they move to
-- `sector`, and the free-text column is cleared only where it held nothing but that word — a real
-- department name ("PWD", "NHAI") is left exactly as it was.
UPDATE "projects"."Project"
   SET "sector" = 'government'
 WHERE "sector" IS NULL
   AND (lower(btrim(coalesce("departmentType", ''))) IN ('government', 'govt', 'govt.', 'gov', 'gov.', 'government department')
     OR lower(btrim(coalesce("projectType", ''))) IN ('government', 'govt', 'govt.', 'gov', 'gov.'));

UPDATE "projects"."Project"
   SET "sector" = 'private'
 WHERE "sector" IS NULL
   AND (lower(btrim(coalesce("departmentType", ''))) IN ('private', 'pvt', 'pvt.', 'private sector')
     OR lower(btrim(coalesce("projectType", ''))) IN ('private', 'pvt', 'pvt.'));

UPDATE "projects"."Project"
   SET "departmentType" = NULL
 WHERE lower(btrim(coalesce("departmentType", ''))) IN ('government', 'govt', 'govt.', 'gov', 'gov.', 'government department', 'private', 'pvt', 'pvt.', 'private sector');

UPDATE "projects"."Project"
   SET "projectType" = NULL
 WHERE lower(btrim(coalesce("projectType", ''))) IN ('government', 'govt', 'govt.', 'gov', 'gov.', 'private', 'pvt', 'pvt.');

-- A company's own requirement set takes the shipped per-type defaults for the declared kinds that
-- only a government contract carries (048): the LOA/LOI, the mining permission and the agreement are
-- not asked of a private project. Every other row keeps both flags, so government and untyped projects
-- are held to exactly what they were held to before.
UPDATE "projects"."ProjectDocumentRequirement" r
   SET "forPrivate" = false
  FROM "settings"."DocumentType" t
 WHERE t."id" = r."documentTypeId"
   AND upper(t."code") IN ('LOI', 'MINING_PERMISSION', 'AGREEMENT');
