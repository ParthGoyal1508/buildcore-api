-- 018 Phases 1 to 3 (`bugs.md` items 11 and 12): the BOQ gets a rate, and bills get lines.
--
-- Note 12's complaint is that `RABill` holds a single `amount`: a bill that is one figure cannot be
-- reconciled against a BOQ, so nobody could say what had been billed of which item.

-- ── Phase 1: the BOQ gets a rate ──────────────────────────────────────────────────────────────────
--
-- Default 0 for two reasons. The table is populated, so a required column cannot be added to it — and
-- of the two ways to be wrong, a zero rate is *visibly* wrong on a bill while a guessed one is
-- invisibly wrong. Billing refuses a line still at 0 with `BOQ_RATE_MISSING`.
ALTER TABLE "projects"."BOQTaskItem"
  ADD COLUMN "rate" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "isVariation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "variationRef" TEXT;

-- The **quoted percentage**, read off `docs/BOQ_794578.xls` after the client supplied it.
--
-- That file is a government e-tender "Percentage BoQ": the bidder quotes one percentage against the
-- schedule of rates rather than a rate per line. Its own footer shows `Total in Figures`
-- 2,99,61,506.78 becoming `Quoted Rate in Figures` 3,06,98,559.85 at `Excess (+) 0.0246`.
--
-- **A bill priced from the line rate alone under-bills by exactly this percentage, on every line** —
-- ₹7.37 lakh on that ₹3 crore project. Invisible per line, material in total, which is the worst
-- shape a billing error takes. A signed fraction, because the same column carries a `Less (-)` quote;
-- 0 means "at par", which is both the common case and the safe default.
ALTER TABLE "projects"."Project"
  ADD COLUMN "quotedPercentage" DECIMAL(8,6) NOT NULL DEFAULT 0;

-- Retention withheld per RA bill, as a fraction. FR-008's first deduction.
ALTER TABLE "projects"."WorkOrder"
  ADD COLUMN "retentionPercent" DECIMAL(8,6) NOT NULL DEFAULT 0;

-- ── Phase 2: client bills with lines ──────────────────────────────────────────────────────────────

CREATE TYPE "projects"."ClientBillStatus" AS ENUM ('draft', 'submitted', 'certified');

CREATE TABLE "projects"."ClientBill" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "billNumber" TEXT NOT NULL,
  "description" TEXT,
  "billingDate" DATE NOT NULL,
  -- Frozen at composition alongside each line's rate: the project's percentage can be corrected, and
  -- a bill whose total moved after it went to the client is a bill nobody can reconcile against the
  -- payment that came back.
  "quotedPercentage" DECIMAL(8,6) NOT NULL DEFAULT 0,
  "grossAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- Retention is the **client's** money held back, not a project cost.
  "retentionAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "netAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- Kept alongside the billed figures, never instead of them: the variance is what a project manager
  -- chases, and overwriting billed with certified erases the fact that there was a shortfall.
  "certifiedAmount" DECIMAL(18,2),
  "certifiedAt" TIMESTAMP(3),
  "status" "projects"."ClientBillStatus" NOT NULL DEFAULT 'draft',
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ClientBill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientBill_project_number_key"
  ON "projects"."ClientBill" ("projectId", "billNumber");
CREATE INDEX "ClientBill_companyId_idx" ON "projects"."ClientBill" ("companyId");
CREATE INDEX "ClientBill_project_status_idx"
  ON "projects"."ClientBill" ("projectId", "status");

CREATE TABLE "projects"."ClientBillLine" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "clientBillId" TEXT NOT NULL,
  "boqTaskItemId" TEXT NOT NULL,
  "quantity" DECIMAL(18,3) NOT NULL,
  -- **The BOQ rate frozen at composition** (FR-002). The assertion the whole feature turns on: revise
  -- the BOQ rate afterwards and a submitted bill does not move. A bill is a document that was sent; a
  -- rate table is a current opinion, and reading the second to render the first makes every historical
  -- bill a lie that changes shape.
  "rate" DECIMAL(18,2) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  -- A flag at composition, a refusal at submit. Over-measurement happens on real sites and is often
  -- correct; refusing it at entry means the measurement never gets recorded anywhere.
  "exceedsScope" BOOLEAN NOT NULL DEFAULT false,
  "overScopeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ClientBillLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientBillLine_bill_item_key"
  ON "projects"."ClientBillLine" ("clientBillId", "boqTaskItemId");
CREATE INDEX "ClientBillLine_companyId_idx" ON "projects"."ClientBillLine" ("companyId");
CREATE INDEX "ClientBillLine_boqTaskItemId_idx"
  ON "projects"."ClientBillLine" ("boqTaskItemId");

-- ── Phase 3: subcontractor bills measured against the award ───────────────────────────────────────

CREATE TABLE "projects"."WorkOrderBOQItem" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "workOrderId" TEXT NOT NULL,
  -- Nullable: a subcontract can cover work the client's BOQ itemises differently, and forcing a match
  -- would make somebody invent one.
  "boqTaskItemId" TEXT,
  "description" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "awardedQty" DECIMAL(18,3) NOT NULL,
  -- The **subcontractor's** rate. Separate from the client's BOQ rate because the margin between the
  -- two is what item 11's P&L exists to show; one column called "the rate" makes that unrepresentable.
  "rate" DECIMAL(18,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkOrderBOQItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkOrderBOQItem_companyId_idx" ON "projects"."WorkOrderBOQItem" ("companyId");
CREATE INDEX "WorkOrderBOQItem_workOrderId_idx" ON "projects"."WorkOrderBOQItem" ("workOrderId");

CREATE TABLE "projects"."RABillLine" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "raBillId" TEXT NOT NULL,
  "workOrderBoqItemId" TEXT NOT NULL,
  "quantity" DECIMAL(18,3) NOT NULL,
  "rate" DECIMAL(18,2) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RABillLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RABillLine_bill_item_key"
  ON "projects"."RABillLine" ("raBillId", "workOrderBoqItemId");
CREATE INDEX "RABillLine_companyId_idx" ON "projects"."RABillLine" ("companyId");
CREATE INDEX "RABillLine_workOrderBoqItemId_idx"
  ON "projects"."RABillLine" ("workOrderBoqItemId");

-- **Gross, the three deductions, and net — each in its own column** (FR-008). Not one net figure: a
-- subcontractor disputing a payment asks which deduction accounts for the difference. And for the
-- P&L, retention is money withheld and an advance recovery is money already paid, so **neither is a
-- project cost** — a summary treating net as spend would understate the project.
ALTER TABLE "projects"."RABill"
  ADD COLUMN "workOrderId" TEXT,
  ADD COLUMN "grossAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "retentionAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "advanceRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "otherDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0;

CREATE INDEX "RABill_workOrderId_idx" ON "projects"."RABill" ("workOrderId");

-- Bills raised before this migration keep `amount` as the only figure they ever had. Backfilling
-- `grossAmount` from it would be defensible; backfilling `netPayable` would not, because nobody knows
-- what was deducted. So `grossAmount` is set and the deductions stay zero, which is the one reading
-- that is true of a bill with no deduction record: gross equals net.
UPDATE "projects"."RABill"
SET "grossAmount" = "amount", "netPayable" = "amount"
WHERE "grossAmount" = 0 AND "amount" <> 0;

-- ── Foreign keys ──────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "projects"."ClientBill"
  ADD CONSTRAINT "ClientBill_projectId_fkey" FOREIGN KEY ("projectId")
  REFERENCES "projects"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects"."ClientBillLine"
  ADD CONSTRAINT "ClientBillLine_clientBillId_fkey" FOREIGN KEY ("clientBillId")
  REFERENCES "projects"."ClientBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `Restrict`, not `Cascade`: deleting a BOQ line that has been billed would delete the billed figure
-- with it, and a bill that quietly loses a line is worse than a delete that refuses.
ALTER TABLE "projects"."ClientBillLine"
  ADD CONSTRAINT "ClientBillLine_boqTaskItemId_fkey" FOREIGN KEY ("boqTaskItemId")
  REFERENCES "projects"."BOQTaskItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects"."WorkOrderBOQItem"
  ADD CONSTRAINT "WorkOrderBOQItem_workOrderId_fkey" FOREIGN KEY ("workOrderId")
  REFERENCES "projects"."WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects"."WorkOrderBOQItem"
  ADD CONSTRAINT "WorkOrderBOQItem_boqTaskItemId_fkey" FOREIGN KEY ("boqTaskItemId")
  REFERENCES "projects"."BOQTaskItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "projects"."RABillLine"
  ADD CONSTRAINT "RABillLine_raBillId_fkey" FOREIGN KEY ("raBillId")
  REFERENCES "projects"."RABill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects"."RABillLine"
  ADD CONSTRAINT "RABillLine_workOrderBoqItemId_fkey" FOREIGN KEY ("workOrderBoqItemId")
  REFERENCES "projects"."WorkOrderBOQItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects"."RABill"
  ADD CONSTRAINT "RABill_workOrderId_fkey" FOREIGN KEY ("workOrderId")
  REFERENCES "projects"."WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS (Principle IV) ────────────────────────────────────────────────────────────────────────────
--
-- All four tables carry billed money, so every one gets an explicit `WITH CHECK` as well as `USING`:
-- a policy with only `USING` filters reads and admits any write naming another tenant.

ALTER TABLE "projects"."ClientBill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ClientBill" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ClientBill"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."ClientBillLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ClientBillLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ClientBillLine"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."WorkOrderBOQItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."WorkOrderBOQItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."WorkOrderBOQItem"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "projects"."RABillLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."RABillLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."RABillLine"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
