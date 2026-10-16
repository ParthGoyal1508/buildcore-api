-- Leave and expense claims go to the employee's reporting manager first, then HR (2026-10-16).
-- Additive: existing rows keep a null manager and stay where they are — in HR's queue.

ALTER TABLE "hr"."LeaveApplication"
  ADD COLUMN "managerUserId" TEXT,
  ADD COLUMN "managerDecidedAt" TIMESTAMP(3),
  ADD COLUMN "managerRemarks" TEXT;
CREATE INDEX "LeaveApplication_managerUserId_status_idx" ON "hr"."LeaveApplication"("managerUserId", "status");

ALTER TABLE "hr"."ReimbursementClaim"
  ADD COLUMN "managerUserId" TEXT,
  ADD COLUMN "managerDecidedAt" TIMESTAMP(3),
  ADD COLUMN "managerRemarks" TEXT;
CREATE INDEX "ReimbursementClaim_managerUserId_status_idx" ON "hr"."ReimbursementClaim"("managerUserId", "status");
