-- A debit note as the client's own document (2026-10-15): a header — the subcontractor's work
-- order, the date, the nature of work, the GST — with item lines under it, per the client's
-- "Parth Realcon DV-04, debit note" format. Until now a debit was one line with no party, which
-- the format cannot be drawn from: it names the party, its work order, its GSTIN and vendor code,
-- and lists several items under one number.
--
-- The existing `BillPackageDebit` rows become the lines. Each one already recorded gets a note of
-- its own, carrying its number and its figures, so nothing in the register moves.

CREATE TABLE "projects"."BillPackageDebitNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workOrderId" TEXT,
    "noteNumber" TEXT,
    "noteDate" DATE NOT NULL,
    "natureOfWork" TEXT,
    "taxBasis" "projects"."BillTaxBasis",
    "gstPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "recoveredOnPackageId" TEXT,
    "recordedByUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPackageDebitNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillPackageDebitNote_companyId_noteNumber_key"
  ON "projects"."BillPackageDebitNote"("companyId", "noteNumber");
CREATE INDEX "BillPackageDebitNote_companyId_projectId_idx"
  ON "projects"."BillPackageDebitNote"("companyId", "projectId");
CREATE INDEX "BillPackageDebitNote_workOrderId_idx"
  ON "projects"."BillPackageDebitNote"("workOrderId");
CREATE INDEX "BillPackageDebitNote_recoveredOnPackageId_idx"
  ON "projects"."BillPackageDebitNote"("recoveredOnPackageId");

ALTER TABLE "projects"."BillPackageDebitNote" ADD CONSTRAINT "BillPackageDebitNote_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects"."BillPackageDebitNote" ADD CONSTRAINT "BillPackageDebitNote_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "projects"."WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects"."BillPackageDebitNote" ADD CONSTRAINT "BillPackageDebitNote_recoveredOnPackageId_fkey"
  FOREIGN KEY ("recoveredOnPackageId") REFERENCES "projects"."BillPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "projects"."BillPackageDebitNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BillPackageDebitNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BillPackageDebitNote"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."BillPackageDebit" ADD COLUMN "noteId" TEXT;
CREATE INDEX "BillPackageDebit_noteId_idx" ON "projects"."BillPackageDebit"("noteId");
ALTER TABLE "projects"."BillPackageDebit" ADD CONSTRAINT "BillPackageDebit_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "projects"."BillPackageDebitNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One note per debit already recorded, keyed off the debit's own id so this is repeatable.
-- The tax was entered as a with-tax figure, never split, so `taxBasis` stays null and the note
-- prints it as one GST line; the work order was never recorded, so it stays null too.
INSERT INTO "projects"."BillPackageDebitNote" (
  "id", "companyId", "projectId", "workOrderId", "noteNumber", "noteDate", "natureOfWork",
  "taxBasis", "gstPercent", "amount", "taxAmount", "netAmount", "recoveredOnPackageId",
  "recordedByUserId", "recordedAt", "createdAt", "updatedAt"
)
SELECT
  'dn_' || d."id", d."companyId", d."projectId", NULL, d."noteNumber", d."recordedAt"::date,
  d."groupHeading", NULL,
  CASE WHEN d."amount" > 0
    THEN GREATEST(LEAST(ROUND((d."amountWithTax" / d."amount" - 1) * 100, 2), 999.99), 0)
    ELSE 0 END,
  d."amount", d."amountWithTax" - d."amount", d."amountWithTax", d."recoveredOnPackageId",
  d."recordedByUserId", d."recordedAt", d."createdAt", NOW()
FROM "projects"."BillPackageDebit" d
WHERE d."noteId" IS NULL;

UPDATE "projects"."BillPackageDebit" SET "noteId" = 'dn_' || "id" WHERE "noteId" IS NULL;
