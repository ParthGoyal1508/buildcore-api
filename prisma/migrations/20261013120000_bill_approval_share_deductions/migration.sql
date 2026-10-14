-- Bill packages go through approval before issue, record sharing and certification, and carry
-- free-form recovery/deduction lines. Vendors gain bank details for the payment advice.

-- CreateEnum
CREATE TYPE "projects"."BillDeductionSection" AS ENUM ('recovery', 'deduction');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "projects"."BillPackageStatus" ADD VALUE 'pending_approval';
ALTER TYPE "projects"."BillPackageStatus" ADD VALUE 'approved';

-- AlterTable
ALTER TABLE "partners"."Vendor" ADD COLUMN     "bankAccountHolderName" TEXT,
ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankBranch" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "ifscCode" TEXT;

-- AlterTable
ALTER TABLE "projects"."BillPackage" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "certifiedAmount" DECIMAL(18,2),
ADD COLUMN     "certifiedAt" TIMESTAMP(3),
ADD COLUMN     "certifiedByUserId" TEXT,
ADD COLUMN     "certifiedRemarks" TEXT,
ADD COLUMN     "customDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customDeductionsUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customRecoveries" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customRecoveriesUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sharedAt" TIMESTAMP(3),
ADD COLUMN     "sharedByUserId" TEXT,
ADD COLUMN     "sharedTo" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "projects"."RABillPayment" ADD COLUMN     "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "transactionNo" TEXT;

-- CreateTable
CREATE TABLE "projects"."BillPackageDeduction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "section" "projects"."BillDeductionSection" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uptoPrevious" DECIMAL(18,2),
    "uptoDate" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPackageDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillPackageDeduction_companyId_idx" ON "projects"."BillPackageDeduction"("companyId");

-- CreateIndex
CREATE INDEX "BillPackageDeduction_packageId_idx" ON "projects"."BillPackageDeduction"("packageId");

-- AddForeignKey
ALTER TABLE "projects"."BillPackageDeduction" ADD CONSTRAINT "BillPackageDeduction_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "projects"."BillPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, the same tenant policy as the package's other children.
ALTER TABLE "projects"."BillPackageDeduction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BillPackageDeduction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BillPackageDeduction"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- Backfill: a package already certified carries its client bill's certified figure, so the new
-- column agrees with what the Client bills tab has always shown.
UPDATE "projects"."BillPackage" p
SET "certifiedAmount" = cb."certifiedAmount", "certifiedAt" = cb."certifiedAt"
FROM "projects"."ClientBill" cb
WHERE p."clientBillId" = cb."id" AND p."status" = 'certified';

-- Backfill: a subcontractor package certified before this release left its RA bill `submitted`,
-- which the payment screen refuses. Certified is what the payment screen is waiting for.
UPDATE "projects"."RABill" rb
SET "status" = 'approved', "approvedAt" = COALESCE(rb."approvedAt", NOW())
FROM "projects"."BillPackage" p
WHERE p."raBillId" = rb."id" AND p."status" = 'certified' AND rb."status" = 'submitted';
