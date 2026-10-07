-- CreateEnum
CREATE TYPE "projects"."PaymentInstrument" AS ENUM ('bank_transfer', 'cheque', 'cash', 'adjustment');

-- CreateEnum
CREATE TYPE "projects"."SignedCopySubject" AS ENUM ('ra_bill', 'debit_note');

-- AlterTable
ALTER TABLE "projects"."RABill" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "projects"."RABillPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "raBillId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "instrument" "projects"."PaymentInstrument" NOT NULL,
    "reference" TEXT,
    "remarks" TEXT,
    "recordedByUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RABillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."SignedCopy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subjectType" "projects"."SignedCopySubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignedCopy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RABillPayment_companyId_raBillId_idx" ON "projects"."RABillPayment"("companyId", "raBillId");

-- CreateIndex
CREATE INDEX "SignedCopy_companyId_subjectType_subjectId_idx" ON "projects"."SignedCopy"("companyId", "subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "projects"."RABillPayment" ADD CONSTRAINT "RABillPayment_raBillId_fkey" FOREIGN KEY ("raBillId") REFERENCES "projects"."RABill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Row-level security (Principle IV, non-negotiable).
--
-- Appended to the generated DDL rather than hand-edited into it: Prisma cannot express a policy, so
-- every table in this database carries one added exactly this way — see
-- `20260829120000_projects_rls_policies`, which is where `RABill` and its siblings got theirs. The
-- generated half above is untouched.
--
-- Both of these hold facts a tenant would not survive leaking. A payment row is what one company
-- paid one subcontractor and when; a signed copy is the countersigned document itself, and its
-- `fileRef` is the key that fetches it out of storage — a leaked reference is a leaked document,
-- not merely a leaked row.
ALTER TABLE "projects"."RABillPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."RABillPayment" FORCE ROW LEVEL SECURITY;
-- Both `USING` and `WITH CHECK`, as 023's four tables in this schema state them. Postgres does
-- apply `USING` to new rows when `WITH CHECK` is absent, so the second clause is not strictly
-- required — but `test/ra-bill-package-rls.e2e-spec.ts` asserts its presence structurally, and a
-- policy that relies on a default is a policy whose write half nobody can see.
CREATE POLICY "tenant_isolation" ON "projects"."RABillPayment"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."SignedCopy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."SignedCopy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."SignedCopy"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
