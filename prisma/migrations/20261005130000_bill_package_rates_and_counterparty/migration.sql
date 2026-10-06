-- The rates a bill is computed at, and the counterparty a bill is to.
--
-- Both are consequences of writing the composition rather than of planning it.
--
-- **The rates.** FR-023 requires every rate to come from configuration or from the contract and
-- none to be fixed in the system, and research §4 requires a missing rate to be a refusal rather
-- than a default of zero. Nothing in the schema carried a tax rate at all, and only
-- `WorkOrder.retentionPercent` carried a retention term — so a client bill had nowhere to read one
-- from. The four statutory rates go on `settings.Company` beside `bocwCessRate`, which is this
-- repository's existing home for exactly this kind of value and is read through its owning service
-- for Principle I. `Project.clientRetentionFraction` is nullable with no default: null means nobody
-- recorded the term and is refused, 0 means the contract has none.
--
-- **The counterparty.** `BillPackage` was keyed on project and direction alone, which conflates two
-- subcontractors on one project: they would share one running series, so A's bills would be RA-01
-- and RA-03 while B's were RA-02 and RA-04. FR-002's overlap check has the same shape — one project
-- is billed to its client and to several subcontractors over the same month, legitimately — so the
-- key is the counterparty and both the unique constraint and the overlap index move onto it.
--
-- Additive against an empty table: `BillPackage` held 0 rows, so the NOT NULL column needs no
-- default and no backfill.

-- DropIndex
DROP INDEX "projects"."BillPackage_projectId_direction_sequenceNo_key";

-- DropIndex
DROP INDEX "projects"."BillPackage_projectId_periodFrom_periodTo_idx";

-- AlterTable
ALTER TABLE "projects"."BillPackage" ADD COLUMN     "counterpartyKey" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "projects"."Project" ADD COLUMN     "clientRetentionFraction" DECIMAL(8,6);

-- AlterTable
ALTER TABLE "settings"."Company" ADD COLUMN     "cgstFraction" DECIMAL(8,6) NOT NULL DEFAULT 0.090000,
ADD COLUMN     "igstFraction" DECIMAL(8,6) NOT NULL DEFAULT 0.180000,
ADD COLUMN     "sgstFraction" DECIMAL(8,6) NOT NULL DEFAULT 0.090000,
ADD COLUMN     "tdsFraction" DECIMAL(8,6) NOT NULL DEFAULT 0.020000;

-- CreateIndex
CREATE INDEX "BillPackage_projectId_direction_counterpartyKey_periodFrom__idx" ON "projects"."BillPackage"("projectId", "direction", "counterpartyKey", "periodFrom", "periodTo");

-- CreateIndex
CREATE UNIQUE INDEX "BillPackage_projectId_direction_counterpartyKey_sequenceNo_key" ON "projects"."BillPackage"("projectId", "direction", "counterpartyKey", "sequenceNo");

