-- 021 FR-016 Phase 8: a clearance waiver becomes a reviewable item.
--
-- The client's answer was "HR, with a Director countersign". Until now a waiver needed only write
-- access on Employees — a placeholder, and wider than a write-off of company money deserves.

-- Who countersigned, separate from who proposed. Nullable for rows written before this phase,
-- which were applied on HR's authority alone; backfilling them with the proposer would record a
-- countersignature that never happened.
ALTER TABLE "hr"."ExitClearanceWaiver"
  ADD COLUMN "approvedByUserId" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3);

-- A pending proposal lives in its own table, not as a status on the waiver. The existence of a
-- waiver row is what unblocks a final settlement, so a pending row in that table would be one
-- forgotten WHERE clause away from clearing an obligation nobody approved.
CREATE TABLE "hr"."ExitClearanceWaiverProposal" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "exitRecordId" TEXT NOT NULL,
  "itemKind" TEXT NOT NULL,
  "itemRef" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "proposedByUserId" TEXT NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'pending',

  CONSTRAINT "ExitClearanceWaiverProposal_pkey" PRIMARY KEY ("id")
);

-- One live proposal per obligation: a second while one is pending would put two items in the
-- Director's queue for one decision.
CREATE UNIQUE INDEX "ExitClearanceWaiverProposal_item_status_key"
  ON "hr"."ExitClearanceWaiverProposal" ("exitRecordId", "itemKind", "itemRef", "status");
CREATE INDEX "ExitClearanceWaiverProposal_companyId_idx"
  ON "hr"."ExitClearanceWaiverProposal" ("companyId");
CREATE INDEX "ExitClearanceWaiverProposal_status_idx"
  ON "hr"."ExitClearanceWaiverProposal" ("status");

ALTER TABLE "hr"."ExitClearanceWaiverProposal"
  ADD CONSTRAINT "ExitClearanceWaiverProposal_exitRecordId_fkey"
  FOREIGN KEY ("exitRecordId") REFERENCES "hr"."ExitRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Principle IV. Tenant-scoped like every other table in this schema.
ALTER TABLE "hr"."ExitClearanceWaiverProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."ExitClearanceWaiverProposal" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ExitClearanceWaiverProposal_tenant_isolation"
  ON "hr"."ExitClearanceWaiverProposal"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
