-- CreateEnum
CREATE TYPE "projects"."BillDirection" AS ENUM ('to_client', 'to_subcontractor');

-- CreateEnum
CREATE TYPE "projects"."BillTaxBasis" AS ENUM ('intra_state', 'inter_state');

-- CreateEnum
CREATE TYPE "projects"."BillTaxBasisSource" AS ENUM ('derived_from_gstin', 'from_project_flag');

-- CreateEnum
CREATE TYPE "projects"."BillPackageStatus" AS ENUM ('draft', 'issued', 'certified', 'abandoned');

-- CreateEnum
CREATE TYPE "projects"."ClaimProposalSource" AS ENUM ('approved_measurement', 'no_measurement_source');

-- CreateEnum
CREATE TYPE "projects"."CheckListAnswer" AS ENUM ('yes', 'no', 'not_required');

-- CreateTable
CREATE TABLE "projects"."BillPackage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "direction" "projects"."BillDirection" NOT NULL,
    "clientBillId" TEXT,
    "raBillId" TEXT,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "sequenceNo" INTEGER NOT NULL,
    "retentionFraction" DECIMAL(8,6) NOT NULL,
    "cgstFraction" DECIMAL(8,6) NOT NULL,
    "sgstFraction" DECIMAL(8,6) NOT NULL,
    "igstFraction" DECIMAL(8,6) NOT NULL,
    "tdsFraction" DECIMAL(8,6) NOT NULL,
    "taxBasis" "projects"."BillTaxBasis" NOT NULL,
    "taxBasisSource" "projects"."BillTaxBasisSource" NOT NULL,
    "workDone" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "releaseWithheld" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "recoveryDiesel" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "debitAgainstCivil" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherRecoveries" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "mechanicalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "mobilizationAdvance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "retentionAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "performanceSecurity" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "theftWithheld" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "payable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "mobilizationAdvanceTotal" DECIMAL(18,2),
    "performanceSecurityTotal" DECIMAL(18,2),
    "workDoneUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "releaseWithheldUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "recoveryDieselUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "debitAgainstCivilUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherRecoveriesUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "mechanicalDebitUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "mobilizationAdvanceUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "retentionAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "performanceSecurityUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "theftWithheldUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "payableUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "issuerName" TEXT,
    "issuerGstin" TEXT,
    "issuerPan" TEXT,
    "issuerState" TEXT,
    "issuerAddress" TEXT,
    "receiverName" TEXT,
    "receiverGstin" TEXT,
    "receiverPan" TEXT,
    "receiverState" TEXT,
    "receiverAddress" TEXT,
    "receiverCode" TEXT,
    "natureOfWork" TEXT,
    "location" TEXT,
    "externalWorkOrderNo" TEXT,
    "externalBillNo" TEXT,
    "missingHeaderFields" TEXT[],
    "status" "projects"."BillPackageStatus" NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3),
    "issuedByUserId" TEXT,
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "lastRevisedAt" TIMESTAMP(3),
    "lastRevisedByUserId" TEXT,
    "lastRevisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BillPackageLineClaim" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "clientBillLineId" TEXT,
    "raBillLineId" TEXT,
    "proposedQty" DECIMAL(18,3),
    "proposalSource" "projects"."ClaimProposalSource" NOT NULL,
    "claimedQty" DECIMAL(18,3) NOT NULL,
    "varianceQty" DECIMAL(18,3),
    "reason" TEXT,
    "overClaimed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPackageLineClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BillPackageDebit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "groupHeading" TEXT,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "nos" DECIMAL(18,3),
    "length" DECIMAL(18,3),
    "width" DECIMAL(18,3),
    "quantity" DECIMAL(18,3),
    "unit" TEXT,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "amountWithTax" DECIMAL(18,2) NOT NULL,
    "recoveredOnPackageId" TEXT,
    "recordedByUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPackageDebit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."BillPackageCheckListAnswer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "answer" "projects"."CheckListAnswer",
    "answeredByUserId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPackageCheckListAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillPackage_clientBillId_key" ON "projects"."BillPackage"("clientBillId");

-- CreateIndex
CREATE UNIQUE INDEX "BillPackage_raBillId_key" ON "projects"."BillPackage"("raBillId");

-- CreateIndex
CREATE INDEX "BillPackage_companyId_idx" ON "projects"."BillPackage"("companyId");

-- CreateIndex
CREATE INDEX "BillPackage_projectId_periodFrom_periodTo_idx" ON "projects"."BillPackage"("projectId", "periodFrom", "periodTo");

-- CreateIndex
CREATE UNIQUE INDEX "BillPackage_projectId_direction_sequenceNo_key" ON "projects"."BillPackage"("projectId", "direction", "sequenceNo");

-- CreateIndex
CREATE UNIQUE INDEX "BillPackageLineClaim_clientBillLineId_key" ON "projects"."BillPackageLineClaim"("clientBillLineId");

-- CreateIndex
CREATE UNIQUE INDEX "BillPackageLineClaim_raBillLineId_key" ON "projects"."BillPackageLineClaim"("raBillLineId");

-- CreateIndex
CREATE INDEX "BillPackageLineClaim_companyId_idx" ON "projects"."BillPackageLineClaim"("companyId");

-- CreateIndex
CREATE INDEX "BillPackageLineClaim_packageId_overClaimed_idx" ON "projects"."BillPackageLineClaim"("packageId", "overClaimed");

-- CreateIndex
CREATE INDEX "BillPackageDebit_companyId_projectId_idx" ON "projects"."BillPackageDebit"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "BillPackageDebit_recoveredOnPackageId_idx" ON "projects"."BillPackageDebit"("recoveredOnPackageId");

-- CreateIndex
CREATE INDEX "BillPackageCheckListAnswer_companyId_idx" ON "projects"."BillPackageCheckListAnswer"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BillPackageCheckListAnswer_packageId_questionKey_key" ON "projects"."BillPackageCheckListAnswer"("packageId", "questionKey");

-- AddForeignKey
ALTER TABLE "projects"."BillPackage" ADD CONSTRAINT "BillPackage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackage" ADD CONSTRAINT "BillPackage_clientBillId_fkey" FOREIGN KEY ("clientBillId") REFERENCES "projects"."ClientBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackage" ADD CONSTRAINT "BillPackage_raBillId_fkey" FOREIGN KEY ("raBillId") REFERENCES "projects"."RABill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackageLineClaim" ADD CONSTRAINT "BillPackageLineClaim_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "projects"."BillPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackageLineClaim" ADD CONSTRAINT "BillPackageLineClaim_clientBillLineId_fkey" FOREIGN KEY ("clientBillLineId") REFERENCES "projects"."ClientBillLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackageLineClaim" ADD CONSTRAINT "BillPackageLineClaim_raBillLineId_fkey" FOREIGN KEY ("raBillLineId") REFERENCES "projects"."RABillLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackageDebit" ADD CONSTRAINT "BillPackageDebit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackageDebit" ADD CONSTRAINT "BillPackageDebit_recoveredOnPackageId_fkey" FOREIGN KEY ("recoveredOnPackageId") REFERENCES "projects"."BillPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."BillPackageCheckListAnswer" ADD CONSTRAINT "BillPackageCheckListAnswer_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "projects"."BillPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Appended by hand: the one constraint Prisma cannot express ────────────────────────────────────
--
-- **This is plan.md's tracked deviation** from the Development Workflow rule that a migration is
-- generated and never hand-edited. Everything above this line is generated; this is one additive
-- statement, kept separate and visible in review.
--
-- `BillPackage` attaches to **exactly one** of a client bill or a subcontractor bill, matching its
-- direction. Prisma's schema language cannot express a constraint spanning two nullable references,
-- and a service-level invariant alone was rejected: a package attached to both bills, or to neither,
-- would produce a document whose figures belong to one bill and whose lines belong to another. The
-- thing it protects is a money document, so it belongs in the database.

ALTER TABLE "projects"."BillPackage"
  ADD CONSTRAINT "BillPackage_one_bill_matching_direction" CHECK (
    ("direction" = 'to_client'        AND "clientBillId" IS NOT NULL AND "raBillId" IS NULL)
    OR
    ("direction" = 'to_subcontractor' AND "raBillId" IS NOT NULL AND "clientBillId" IS NULL)
  );

-- ── RLS (Principle IV, 023 FR-050) ───────────────────────────────────────────────────────────────
--
-- Four new tables, four policies, each with an explicit `WITH CHECK` as well as `USING` — matching
-- 018's tables in this schema, whose own comment says why: a policy with only `USING` filters reads
-- and admits any write naming another tenant. These tables carry billed money.
--
-- **Each policy was read rather than copied**, because the neighbours in this schema disagree
-- (research §7). Both of 008's policies omit `WITH CHECK` and rely on Postgres applying `USING` to
-- new rows; `projects."DWRTask"` has no `companyId` at all and is protected by a correlated lookup
-- on its parent report. All four tables here carry their own `companyId`, so a direct predicate is
-- right — but a `companyId` policy added beside a parent-lookup one would `AND` with it and hide
-- every row, which is why this is checked each time rather than assumed.
--
-- `test/ra-bill-package-rls.e2e-spec.ts` exercises all four under a `NOSUPERUSER NOBYPASSRLS` role,
-- read half and write half (FR-050c), with the non-vacuity assertion first (FR-050a). The
-- development and CI role is a superuser, and Postgres exempts superusers from row-level security
-- unconditionally — so until that suite runs, none of these four policies has ever been in force.

ALTER TABLE "projects"."BillPackage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BillPackage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BillPackage"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."BillPackageLineClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BillPackageLineClaim" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BillPackageLineClaim"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."BillPackageDebit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BillPackageDebit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BillPackageDebit"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."BillPackageCheckListAnswer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BillPackageCheckListAnswer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BillPackageCheckListAnswer"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
