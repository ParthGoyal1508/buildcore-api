-- CreateEnum
CREATE TYPE "shared"."ApprovalState" AS ENUM ('pending', 'approved', 'rejected', 'returned', 'abandoned');

-- CreateEnum
CREATE TYPE "shared"."ApprovalDecisionAction" AS ENUM ('approve', 'reject', 'return');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'APPROVAL_DECISION';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'APPROVAL_REFUSED';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'APPROVAL_CHAIN_CONFIG';

-- CreateTable
CREATE TABLE "shared"."ApprovalChain" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "isFinalAuthorityRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalChain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."ApprovalLevel" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "slotKey" TEXT NOT NULL,
    "isFinalAuthority" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."RoleSlotMapping" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleSlotMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."ApprovalInstance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "href" TEXT,
    "currentPosition" INTEGER NOT NULL DEFAULT 1,
    "state" "shared"."ApprovalState" NOT NULL DEFAULT 'pending',
    "originatorUserId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "returnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."ApprovalDecision" (
    "id" TEXT NOT NULL,
    "approvalInstanceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" "shared"."ApprovalDecisionAction" NOT NULL,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalChain_companyId_actionType_idx" ON "shared"."ApprovalChain"("companyId", "actionType");

-- CreateIndex
CREATE INDEX "ApprovalLevel_companyId_idx" ON "shared"."ApprovalLevel"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLevel_chainId_position_key" ON "shared"."ApprovalLevel"("chainId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLevel_chainId_slotKey_key" ON "shared"."ApprovalLevel"("chainId", "slotKey");

-- CreateIndex
CREATE INDEX "RoleSlotMapping_companyId_idx" ON "shared"."RoleSlotMapping"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSlotMapping_companyId_slotKey_key" ON "shared"."RoleSlotMapping"("companyId", "slotKey");

-- CreateIndex
CREATE INDEX "ApprovalInstance_companyId_state_currentPosition_idx" ON "shared"."ApprovalInstance"("companyId", "state", "currentPosition");

-- CreateIndex
CREATE INDEX "ApprovalInstance_entityType_entityId_idx" ON "shared"."ApprovalInstance"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ApprovalDecision_companyId_idx" ON "shared"."ApprovalDecision"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_approvalInstanceId_round_actorUserId_key" ON "shared"."ApprovalDecision"("approvalInstanceId", "round", "actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_approvalInstanceId_round_position_key" ON "shared"."ApprovalDecision"("approvalInstanceId", "round", "position");

-- AddForeignKey
ALTER TABLE "shared"."ApprovalChain" ADD CONSTRAINT "ApprovalChain_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalLevel" ADD CONSTRAINT "ApprovalLevel_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "shared"."ApprovalChain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalLevel" ADD CONSTRAINT "ApprovalLevel_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."RoleSlotMapping" ADD CONSTRAINT "RoleSlotMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."RoleSlotMapping" ADD CONSTRAINT "RoleSlotMapping_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "settings"."Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalInstance" ADD CONSTRAINT "ApprovalInstance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalInstance" ADD CONSTRAINT "ApprovalInstance_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "shared"."ApprovalChain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalInstance" ADD CONSTRAINT "ApprovalInstance_originatorUserId_fkey" FOREIGN KEY ("originatorUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_approvalInstanceId_fkey" FOREIGN KEY ("approvalInstanceId") REFERENCES "shared"."ApprovalInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-authored from here down. Everything above was generated from
-- schema.prisma; everything below is a constraint or policy Prisma cannot
-- express, following the same exception every feature since 001 has taken.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Partial unique indexes (016 T002) ───────────────────────────────────────
--
-- Both are partial, and the predicate is the whole point in each case — which is
-- why neither can live in schema.prisma. The precedent is
-- `GangMember_workerId_active_key` and `MusterRoll_siteId_date_active_key` in
-- 20260904120000_labour_module.

-- One *active* chain per action type per company. Inactive chains are kept rather
-- than deleted, because items already in flight continue under the chain they
-- entered — so the uniqueness has to exclude them or a chain could never be
-- superseded.
CREATE UNIQUE INDEX "ApprovalChain_companyId_actionType_active_key"
  ON "shared"."ApprovalChain"("companyId", "actionType")
  WHERE "isActive";

-- One live chain per item (016 FR-007, data-model.md).
--
-- This is what stops a double-submit creating two parallel approvals of the same
-- thing. It MUST be partial: `approved`, `rejected` and `abandoned` are terminal
-- and an item may legitimately be raised again afterwards, so a plain unique would
-- permanently bar a corrected item from re-entering a chain.
--
-- `returned` is deliberately INSIDE the live set. A returned item is awaiting its
-- originator's correction and still holds the item's chain slot; excluding it would
-- let a second instance be submitted for an item that is already mid-correction.
CREATE UNIQUE INDEX "ApprovalInstance_entityType_entityId_live_key"
  ON "shared"."ApprovalInstance"("entityType", "entityId")
  WHERE "state" IN ('pending', 'returned');

-- ── Row-level security (016 T004, Constitution Principle IV) ────────────────
--
-- The session-variable pattern established in 20260829073000_settings_rls_policies
-- and extended by every feature since, set by src/common/prisma/rls-context.ts.
--
-- FORCE, not merely ENABLE: without it the table owner bypasses its own policy,
-- which is the difference between a policy that is written and one that is in
-- effect.
--
-- All five tables take the identical equality test, including the two that reach
-- their company through a parent (`ApprovalLevel` via its chain, `ApprovalDecision`
-- via its instance). Both carry a denormalised, write-once `companyId` for exactly
-- this reason — see the `///` comments on those columns. A policy shape used
-- everywhere is one a future table copies correctly.
--
-- `ApprovalInstance` and `ApprovalDecision` are read on the approval-queue path by
-- ORDINARY users, not just administrators. This is the one place in this feature
-- where a policy mistake would leak one company's pending work into another
-- company's queue, which is why both have explicit non-super-admin tests
-- (016 T054).

ALTER TABLE "shared"."ApprovalChain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ApprovalChain" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ApprovalChain"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "shared"."ApprovalLevel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ApprovalLevel" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ApprovalLevel"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "shared"."RoleSlotMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."RoleSlotMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."RoleSlotMapping"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "shared"."ApprovalInstance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ApprovalInstance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ApprovalInstance"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "shared"."ApprovalDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ApprovalDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ApprovalDecision"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
