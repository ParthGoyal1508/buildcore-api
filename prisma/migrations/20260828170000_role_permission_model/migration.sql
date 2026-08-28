-- Captured before the DROP COLUMN below, for backfilling UserRole from the old
-- single-value enum (dev-fixture data only — see the backfill INSERT further down).
CREATE TEMP TABLE _role_backfill AS
  SELECT id, email, role::text AS old_role FROM "shared"."User";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "settings";

-- CreateEnum
CREATE TYPE "settings"."Permission" AS ENUM ('DASHBOARD', 'EMPLOYEES', 'ATTENDANCE', 'PROJECTS', 'DWR', 'PROJECT_FINANCIALS', 'MACHINERY', 'INVENTORY', 'PARTNERS', 'REPORTS', 'PAYROLL', 'CHALLANS', 'LOANS', 'LOGBOOK', 'FUEL', 'DAILY_WORKER_REGISTRY', 'MY_WORKSPACE', 'SETTINGS', 'USER_MANAGEMENT', 'COMPANY_SETTINGS', 'DATA_EXPORT', 'DATA_DELETE', 'CROSS_COMPANY_ACCESS');

-- AlterTable
ALTER TABLE "shared"."User" DROP COLUMN "role";

-- DropEnum
DROP TYPE "shared"."Role";

-- CreateTable
CREATE TABLE "settings"."Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" "settings"."Permission"[],
    "isProtected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "settings"."Role"("name");

-- CreateIndex
CREATE INDEX "UserRole_userId_idx" ON "settings"."UserRole"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "settings"."UserRole"("userId", "roleId");

-- AddForeignKey
ALTER TABLE "settings"."UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "settings"."Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed: the one permanent, protected role this feature itself depends on. The other
-- eight default roles from the PRD are 002-settings-backend's own seeding work, once
-- it owns role management (see schema.prisma's Role model comment).
INSERT INTO "settings"."Role" (id, name, permissions, "isProtected", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'Super Admin',
  ARRAY[
    'DASHBOARD','EMPLOYEES','ATTENDANCE','PROJECTS','DWR','PROJECT_FINANCIALS','MACHINERY',
    'INVENTORY','PARTNERS','REPORTS','PAYROLL','CHALLANS','LOANS','LOGBOOK','FUEL',
    'DAILY_WORKER_REGISTRY','MY_WORKSPACE','SETTINGS','USER_MANAGEMENT','COMPANY_SETTINGS',
    'DATA_EXPORT','DATA_DELETE','CROSS_COMPANY_ACCESS'
  ]::"settings"."Permission"[],
  true,
  now()
);

-- Backfill: dev-fixture data only (the two seed.ts accounts) — the account that used
-- to be the placeholder "ADMIN" enum value becomes a Super Admin role assignment, so
-- local dev doesn't lose its one privileged account. A no-op on a database with no
-- prior "ADMIN"-role row.
INSERT INTO "settings"."UserRole" (id, "userId", "roleId", "companyId", "createdAt")
SELECT gen_random_uuid()::text, b.id, r.id, u."companyId", now()
FROM _role_backfill b
JOIN "shared"."User" u ON u.id = b.id
CROSS JOIN "settings"."Role" r
WHERE b.old_role = 'ADMIN' AND r.name = 'Super Admin';

-- Row-Level Security on UserRole (who holds a role IS tenant data, unlike Role
-- itself — see schema.prisma's Role/UserRole comments for why the split). Same
-- pattern as migration 20260828162304: FORCE (not just ENABLE) because this DB
-- user is the tables' owner, which Postgres otherwise exempts from RLS by default;
-- `app.is_super_admin` is the same bypass flag the earlier migration introduced —
-- its meaning has generalized from "role === SUPER_ADMIN" to "caller holds
-- CROSS_COMPANY_ACCESS", but the session-variable plumbing itself doesn't need
-- renaming (see src/common/prisma/rls-context.ts).
ALTER TABLE "settings"."UserRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."UserRole" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."UserRole"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
