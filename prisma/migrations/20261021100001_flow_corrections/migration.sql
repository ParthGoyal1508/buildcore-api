-- 039 flow corrections (2026-10-20):
--   1. Job card: site raises it with the quotation → Head Office approves or sends it for correction
--      → site uploads the final bill → Head Office records payment; every step in JobCardEvent.
--   2. Payroll: hand edits to a generated line, each with a justification (PayrollLineItemEdit), and
--      the run goes to the Director alone for approval before the bank sheet.
--   3. Inventory: composite items (a mix issued as its sub-items in fixed proportions).

-- Production connects as `buildcore_app` (NOBYPASSRLS); the chain data below must pass the
-- shared tables' tenant policy there, not only as the local superuser.
SELECT set_config('app.is_super_admin', 'true', true);

-- CreateEnum
CREATE TYPE "plant"."JobCardStatus" AS ENUM ('draft', 'pending_approval', 'returned', 'approved', 'bill_uploaded', 'paid');

-- CreateEnum
CREATE TYPE "plant"."JobCardPaymentMode" AS ENUM ('bank_transfer', 'cheque', 'upi', 'cash');



-- AlterTable
ALTER TABLE "inventory"."Issue" ADD COLUMN     "compositeItemId" TEXT,
ADD COLUMN     "compositeQuantity" DECIMAL(18,3),
ADD COLUMN     "issueGroupId" TEXT;

-- AlterTable
ALTER TABLE "payroll"."PayrollLineItem" ADD COLUMN     "editedFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "plant"."MaintenanceJob" ADD COLUMN     "finalBillAmount" DECIMAL(18,2),
ADD COLUMN     "finalBillContentType" TEXT,
ADD COLUMN     "finalBillDate" DATE,
ADD COLUMN     "finalBillFileName" TEXT,
ADD COLUMN     "finalBillFileRef" TEXT,
ADD COLUMN     "finalBillNumber" TEXT,
ADD COLUMN     "finalBillUploadedAt" TIMESTAMP(3),
ADD COLUMN     "finalBillUploadedBy" TEXT,
ADD COLUMN     "jobCardApprovalItemId" TEXT,
ADD COLUMN     "jobCardReturnRemarks" TEXT,
ADD COLUMN     "jobCardStatus" "plant"."JobCardStatus",
ADD COLUMN     "quotationAmount" DECIMAL(18,2),
ADD COLUMN     "quotationContentType" TEXT,
ADD COLUMN     "quotationFileName" TEXT,
ADD COLUMN     "quotationFileRef" TEXT;

-- CreateTable
CREATE TABLE "payroll"."PayrollLineItemEdit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "lineItemId" TEXT,
    "employeeId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" DECIMAL(12,2) NOT NULL,
    "newValue" DECIMAL(12,2) NOT NULL,
    "justification" TEXT NOT NULL,
    "editedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollLineItemEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."CompositeItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "settings"."ItemUnit" NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompositeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."CompositeItemComponent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "compositeItemId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qtyPerUnit" DECIMAL(18,6) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CompositeItemComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."JobCardEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "maintenanceJobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "plant"."JobCardStatus",
    "toStatus" "plant"."JobCardStatus",
    "remarks" TEXT,
    "detail" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobCardEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant"."JobCardPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "maintenanceJobId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "mode" "plant"."JobCardPaymentMode" NOT NULL,
    "referenceNumber" TEXT,
    "remarks" TEXT,
    "proofFileRef" TEXT,
    "proofFileName" TEXT,
    "proofContentType" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobCardPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollLineItemEdit_companyId_idx" ON "payroll"."PayrollLineItemEdit"("companyId");

-- CreateIndex
CREATE INDEX "PayrollLineItemEdit_payrollRunId_idx" ON "payroll"."PayrollLineItemEdit"("payrollRunId");

-- CreateIndex
CREATE INDEX "PayrollLineItemEdit_lineItemId_createdAt_idx" ON "payroll"."PayrollLineItemEdit"("lineItemId", "createdAt");

-- CreateIndex
CREATE INDEX "CompositeItem_companyId_idx" ON "settings"."CompositeItem"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompositeItem_companyId_name_key" ON "settings"."CompositeItem"("companyId", "name");

-- CreateIndex
CREATE INDEX "CompositeItemComponent_companyId_idx" ON "settings"."CompositeItemComponent"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompositeItemComponent_compositeItemId_itemId_key" ON "settings"."CompositeItemComponent"("compositeItemId", "itemId");

-- CreateIndex
CREATE INDEX "JobCardEvent_companyId_idx" ON "plant"."JobCardEvent"("companyId");

-- CreateIndex
CREATE INDEX "JobCardEvent_maintenanceJobId_createdAt_idx" ON "plant"."JobCardEvent"("maintenanceJobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobCardPayment_companyId_idx" ON "plant"."JobCardPayment"("companyId");

-- CreateIndex
CREATE INDEX "JobCardPayment_maintenanceJobId_idx" ON "plant"."JobCardPayment"("maintenanceJobId");

-- CreateIndex
CREATE INDEX "Issue_issueGroupId_idx" ON "inventory"."Issue"("issueGroupId");

-- CreateIndex
CREATE INDEX "MaintenanceJob_companyId_jobCardStatus_idx" ON "plant"."MaintenanceJob"("companyId", "jobCardStatus");

-- AddForeignKey
ALTER TABLE "payroll"."PayrollLineItemEdit" ADD CONSTRAINT "PayrollLineItemEdit_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "payroll"."PayrollLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."CompositeItemComponent" ADD CONSTRAINT "CompositeItemComponent_compositeItemId_fkey" FOREIGN KEY ("compositeItemId") REFERENCES "settings"."CompositeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."JobCardEvent" ADD CONSTRAINT "JobCardEvent_maintenanceJobId_fkey" FOREIGN KEY ("maintenanceJobId") REFERENCES "plant"."MaintenanceJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant"."JobCardPayment" ADD CONSTRAINT "JobCardPayment_maintenanceJobId_fkey" FOREIGN KEY ("maintenanceJobId") REFERENCES "plant"."MaintenanceJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security: the standard tenant policy ──────────────────────────
ALTER TABLE "plant"."JobCardEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."JobCardEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."JobCardEvent"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."JobCardPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."JobCardPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."JobCardPayment"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "payroll"."PayrollLineItemEdit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."PayrollLineItemEdit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."PayrollLineItemEdit"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."CompositeItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."CompositeItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."CompositeItem"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."CompositeItemComponent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."CompositeItemComponent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."CompositeItemComponent"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── MAINTENANCE_PAY: the Head Office roles ("HO User" by default, "Head Office" where renamed) ──
-- Site roles keep MAINTENANCE to raise and correct cards; who else pays is a Settings → Roles call.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'MAINTENANCE_PAY'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261021100001_flow_corrections'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" IN ('Super Admin', 'HO User', 'Head Office')
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'MAINTENANCE_PAY'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" IN ('Super Admin', 'HO User', 'Head Office')
  AND NOT ('MAINTENANCE_PAY' = ANY (r."permissions"));

-- ── The job card chain, for every company that already exists ───────────────
-- One "Head Office" level on the final slot (Super Admin by default). Idempotent.
INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", 'job_card', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "settings"."Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "shared"."ApprovalChain" ac
  WHERE ac."companyId" = c."id" AND ac."actionType" = 'job_card'
);

INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "label", "isFinalAuthority", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, ac."id", ac."companyId", 1, 'final', 'Head Office', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "shared"."ApprovalChain" ac
WHERE ac."actionType" = 'job_card'
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" al WHERE al."chainId" = ac."id" AND al."position" = 1
  );

-- ── Payroll goes to the Director alone ───────────────────────────────────────
-- Payroll is generated for the whole company, so a Site Incharge level never fitted it. A company
-- still on the default three-level shape (first_approver → hr → final) is moved to one Director
-- level; a chain an administrator has reshaped is left as they made it. Superseded by
-- deactivation, as ChainsService does, so a run already part-way through keeps its old chain.
CREATE TEMP TABLE "_payroll_default_chains" ON COMMIT DROP AS
SELECT ac."id", ac."companyId", ac."isFinalAuthorityRequired"
FROM "shared"."ApprovalChain" ac
WHERE ac."actionType" = 'payroll_run'
  AND ac."isActive"
  AND (SELECT string_agg(al."slotKey", ',' ORDER BY al."position")
       FROM "shared"."ApprovalLevel" al WHERE al."chainId" = ac."id") = 'first_approver,hr,final';

UPDATE "shared"."ApprovalChain" ac
SET "isActive" = false, "updatedAt" = CURRENT_TIMESTAMP
FROM "_payroll_default_chains" d
WHERE ac."id" = d."id";

CREATE TEMP TABLE "_payroll_new_chains" ON COMMIT DROP AS
SELECT gen_random_uuid()::text AS "id", d."companyId", d."isFinalAuthorityRequired"
FROM "_payroll_default_chains" d;

INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isFinalAuthorityRequired", "isActive", "createdAt", "updatedAt")
SELECT n."id", n."companyId", 'payroll_run', n."isFinalAuthorityRequired", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_payroll_new_chains" n;

INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "label", "isFinalAuthority", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, n."id", n."companyId", 1, 'final', 'Director', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_payroll_new_chains" n;
