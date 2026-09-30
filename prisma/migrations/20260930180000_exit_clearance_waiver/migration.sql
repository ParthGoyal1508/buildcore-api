-- 021 Phase 7, 2026-09-30. Exit clearance (FR-014 to FR-018b) — bugs.md item 10.
--
-- One table, and it is **not** the checklist. The clearance is derived on every read from where
-- each obligation already lives: open asset allocations, unreturned recoverable kit, outstanding
-- advances, open reimbursements, the account's state. Only waivers are stored.
--
-- A stored checklist would be a second copy of custody, stale the moment an asset came back
-- through the asset register — and FR-014c requires a return there to satisfy the item here
-- without a second action. Deriving is what makes those the same fact rather than two facts
-- somebody has to keep in step.
--
-- Additive, no backfill, no data statement, so no `set_config` guard. Stated rather than
-- omitted silently: that line belongs where a data statement exists and nowhere else, or it
-- becomes a ritual rather than a decision.

CREATE TABLE "hr"."ExitClearanceWaiver" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "exitRecordId" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "waivedByUserId" TEXT NOT NULL,
    "waivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExitClearanceWaiver_pkey" PRIMARY KEY ("id")
);

-- One waiver per obligation per exit. Waiving the same thing twice is not a second decision, and
-- two rows would make "who waived this?" ambiguous at the moment it matters.
CREATE UNIQUE INDEX "ExitClearanceWaiver_exitRecordId_itemKind_itemRef_key"
  ON "hr"."ExitClearanceWaiver"("exitRecordId", "itemKind", "itemRef");

CREATE INDEX "ExitClearanceWaiver_companyId_idx"
  ON "hr"."ExitClearanceWaiver"("companyId");

ALTER TABLE "hr"."ExitClearanceWaiver"
  ADD CONSTRAINT "ExitClearanceWaiver_exitRecordId_fkey"
  FOREIGN KEY ("exitRecordId") REFERENCES "hr"."ExitRecord"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hr"."ExitClearanceWaiver" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."ExitClearanceWaiver" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."ExitClearanceWaiver"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
