-- 036 D6: the notification inbox — read/unread state for the bell, in-app only (no email, by
-- product decision). Notifications are still computed by the providers on each request; this
-- table remembers which of them each person has read, per company scope. RLS follows the
-- session-variable pattern every table since 20260829073000_settings_rls_policies uses; the
-- service also filters on userId, since a notification is one person's.

-- CreateTable
CREATE TABLE "shared"."Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "actionLink" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_companyId_key_key" ON "shared"."Notification"("userId", "companyId", "key");
CREATE INDEX "Notification_userId_companyId_resolvedAt_idx" ON "shared"."Notification"("userId", "companyId", "resolvedAt");

-- Row-level security (Constitution Principle IV)
ALTER TABLE "shared"."Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."Notification"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
