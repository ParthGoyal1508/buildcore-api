-- CreateEnum
CREATE TYPE "shared"."ReminderSeverity" AS ENUM ('info', 'warning', 'overdue');

-- AlterEnum
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'REMINDER';

-- CreateTable
CREATE TABLE "shared"."ReminderRule" (
    "id" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "sourceModule" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "leadDays" INTEGER NOT NULL,
    "severityLadder" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."ReminderSnooze" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "snoozeUntil" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderSnooze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."ReminderNotification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "severity" "shared"."ReminderSeverity" NOT NULL,
    "emittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,

    CONSTRAINT "ReminderNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReminderRule_ruleKey_key" ON "shared"."ReminderRule"("ruleKey");

-- CreateIndex
CREATE INDEX "ReminderRule_sourceModule_idx" ON "shared"."ReminderRule"("sourceModule");

-- CreateIndex
CREATE INDEX "ReminderRule_companyId_idx" ON "shared"."ReminderRule"("companyId");

-- CreateIndex
CREATE INDEX "ReminderSnooze_companyId_ruleKey_entityId_idx" ON "shared"."ReminderSnooze"("companyId", "ruleKey", "entityId");

-- CreateIndex
CREATE INDEX "ReminderSnooze_snoozeUntil_idx" ON "shared"."ReminderSnooze"("snoozeUntil");

-- CreateIndex
CREATE INDEX "ReminderNotification_companyId_ruleKey_entityId_idx" ON "shared"."ReminderNotification"("companyId", "ruleKey", "entityId");

-- CreateIndex
CREATE INDEX "ReminderNotification_companyId_closedAt_idx" ON "shared"."ReminderNotification"("companyId", "closedAt");

-- AddForeignKey
ALTER TABLE "shared"."ReminderRule" ADD CONSTRAINT "ReminderRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ReminderSnooze" ADD CONSTRAINT "ReminderSnooze_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ReminderSnooze" ADD CONSTRAINT "ReminderSnooze_ruleKey_fkey" FOREIGN KEY ("ruleKey") REFERENCES "shared"."ReminderRule"("ruleKey") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ReminderNotification" ADD CONSTRAINT "ReminderNotification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."ReminderNotification" ADD CONSTRAINT "ReminderNotification_ruleKey_fkey" FOREIGN KEY ("ruleKey") REFERENCES "shared"."ReminderRule"("ruleKey") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-authored: the FR-032 guarantee ─────────────────────────────────────
--
-- "At most one notification per entity, per rule, per severity band." Prisma has no
-- syntax for a partial unique index, so this is written out — the same exception
-- 008's `Client_companyId_gstin_key` takes.
--
-- Scoped to open rows (`closedAt IS NULL`) because the constraint is about what is
-- currently announced, not about history: a reminder that escalates warning →
-- overdue → warning again over a year legitimately has three closed rows for the
-- same (rule, entity, severity) pairs, and a total unique index would reject the
-- third.
--
-- This is the real guarantee. `RemindersService.evaluateAndEmit()` also checks before
-- inserting, so the caller gets ordinary behaviour rather than a constraint error;
-- that check races with a concurrent evaluation run, and losing the race must fail
-- rather than emit a duplicate.
CREATE UNIQUE INDEX "ReminderNotification_open_unique"
  ON "shared"."ReminderNotification"("companyId", "ruleKey", "entityId", "severity")
  WHERE "closedAt" IS NULL;
