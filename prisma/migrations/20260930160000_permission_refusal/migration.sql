-- 019 Phase 3, 2026-09-30. Recording a refused request (FR-003).
--
-- Additive, no backfill, no data statement — so no `set_config` line is needed here, and
-- saying so is deliberate: the guard belongs where a data statement exists and nowhere else,
-- or it becomes a ritual rather than a decision.

CREATE TABLE "settings"."PermissionRefusal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requiredPermission" "settings"."Permission" NOT NULL,
    "requiredLevel" "settings"."AccessLevel" NOT NULL,
    "heldLevel" "settings"."AccessLevel",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionRefusal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PermissionRefusal_companyId_createdAt_idx"
  ON "settings"."PermissionRefusal"("companyId", "createdAt");

CREATE INDEX "PermissionRefusal_companyId_userId_idx"
  ON "settings"."PermissionRefusal"("companyId", "userId");

-- Tenant isolation, with WITH CHECK written explicitly rather than left to default from
-- USING: Postgres reuses USING when WITH CHECK is omitted, which works but means a later edit
-- to one silently changes the other.
--
-- This table holds who attempted what and was refused. That is security data about named
-- people, so it is isolated like everything else and read only under USER_MANAGEMENT.
ALTER TABLE "settings"."PermissionRefusal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."PermissionRefusal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."PermissionRefusal"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
