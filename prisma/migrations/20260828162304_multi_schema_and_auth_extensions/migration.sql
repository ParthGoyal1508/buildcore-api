-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shared";

-- CreateEnum
CREATE TYPE "shared"."Role" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "shared"."UserStatus" AS ENUM ('active', 'deactivated');

-- CreateEnum
CREATE TYPE "shared"."AuditEventType" AS ENUM ('login_success', 'login_failure', 'account_locked', 'logout', 'refresh_reuse_detected', 'admin_password_reset');

-- CreateTable
CREATE TABLE "shared"."User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "firstname" TEXT,
    "lastname" TEXT,
    "role" "shared"."Role" NOT NULL DEFAULT 'USER',
    "companyId" TEXT,
    "status" "shared"."UserStatus" NOT NULL DEFAULT 'active',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "companyId" TEXT,
    "rememberMe" BOOLEAN NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."AuditLogEntry" (
    "id" TEXT NOT NULL,
    "eventType" "shared"."AuditEventType" NOT NULL,
    "accountId" TEXT,
    "attemptedEmail" TEXT,
    "companyId" TEXT,
    "ipAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "shared"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "shared"."User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "shared"."RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "shared"."RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_accountId_idx" ON "shared"."RefreshToken"("accountId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_accountId_idx" ON "shared"."AuditLogEntry"("accountId");

-- AddForeignKey
ALTER TABLE "shared"."RefreshToken" ADD CONSTRAINT "RefreshToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data migration: this feature moves the account table from the pre-existing
-- undifferentiated "public"."User" into "shared"."User" (research.md §10). Prisma's
-- schema diff can't express a table move across schemas, so it's handled explicitly
-- here — copy any existing rows across (username backfilled from the email
-- local-part + a uniqueness suffix, since no prior username existed), then drop the
-- superseded table. A no-op on a fresh database with no prior "public"."User" rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'User'
  ) THEN
    INSERT INTO "shared"."User"
      ("id", "createdAt", "updatedAt", "email", "username", "password", "firstname", "lastname", "role")
    SELECT
      "id", "createdAt", "updatedAt", "email",
      lower(split_part("email", '@', 1)) || '-' || substr("id", 1, 6),
      "password", "firstname", "lastname",
      CASE WHEN "role"::text = 'ADMIN' THEN 'ADMIN' ELSE 'USER' END::"shared"."Role"
    FROM "public"."User";

    DROP TABLE "public"."User";
  END IF;
END $$;

-- Row-Level Security (Principle IV, FR-020/FR-020a): every tenant-scoped table this
-- feature relies on rejects a cross-company query at the database layer itself, with
-- exactly one explicit, narrow bypass for Super Admin — never a forged matching
-- companyId. FORCE ROW LEVEL SECURITY is required in addition to ENABLE: Postgres
-- exempts a table's own owning role from RLS by default, and this DB user is that
-- owner (research.md §5).
--
-- Application code sets these two session-local values via `set_config(..., true)`
-- inside a transaction before running a company-scoped query (see
-- src/common/prisma/rls-context.ts); UNSET (the default outside such a transaction)
-- means both current_setting() calls below return NULL, so the USING clause's
-- equality/boolean checks are false and no row is visible — a safe default-deny, not
-- an accidental bypass. A handful of specific lookups (login-by-identifier,
-- refresh/logout-by-hashed-token, per-request re-validation-by-id) legitimately run
-- with app.is_super_admin explicitly forced true instead of a real company context,
-- because they identify a single row by a value the caller can't forge (a correct
-- password, a valid opaque token, or the server's own signed JWT claim) rather than
-- by an arbitrary company-scoped filter — see auth.service.ts / jwt.strategy.ts.

ALTER TABLE "shared"."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."User" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."User"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "shared"."RefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."RefreshToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."RefreshToken"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "shared"."AuditLogEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."AuditLogEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."AuditLogEntry"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
