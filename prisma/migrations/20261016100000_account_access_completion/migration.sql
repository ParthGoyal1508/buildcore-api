-- 029: password reset links, a default role for new accounts, and a home page per role.

-- AlterEnum
--
-- Not used later in this file, which is what lets them share it: Postgres refuses a value
-- added in the same transaction that uses it.
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PASSWORD_RESET_COMPLETED';
ALTER TYPE "shared"."AuditAction" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "shared"."AuditAction" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "shared"."AuditAction" ADD VALUE 'PASSWORD_RESET_COMPLETED';

-- AlterTable
ALTER TABLE "settings"."Role" ADD COLUMN     "homeModule" TEXT,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- At most one default role. Partial, because Prisma cannot say "unique where true" and a
-- plain unique index on a boolean would allow exactly two roles in total.
CREATE UNIQUE INDEX "Role_single_default_key" ON "settings"."Role"("isDefault") WHERE "isDefault";

-- CreateTable
CREATE TABLE "shared"."PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "shared"."PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "shared"."PasswordResetToken"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "shared"."PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "shared"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, exactly as shared."InviteToken" has it (20260830132800): tenancy derived
-- through the owning User. The public forgot/reset endpoints look a token up by hash with no
-- caller and run under the system context, as login does.
ALTER TABLE "shared"."PasswordResetToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."PasswordResetToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."PasswordResetToken"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "shared"."User" u
      WHERE u."id" = "shared"."PasswordResetToken"."userId"
        AND u."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- The default role (029 FR-001): My Workspace and nothing else, landing on it after sign-in.
--
-- My Workspace is authorised by ownership — every route acts on the caller's own records — so
-- this role can see nobody else's data. Idempotent, keyed on the unique name: a "General User"
-- an administrator already made keeps its permissions and gains My Workspace, and a home page
-- someone already chose is left alone.
INSERT INTO "settings"."Role" (id, name, permissions, "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'General User', ARRAY['MY_WORKSPACE']::"settings"."Permission"[], false, true, 'my-workspace', now(), now())
ON CONFLICT (name) DO UPDATE
SET "isDefault"   = true,
    "homeModule"  = COALESCE("settings"."Role"."homeModule", EXCLUDED."homeModule"),
    "permissions" = CASE
      WHEN 'MY_WORKSPACE' = ANY ("settings"."Role"."permissions") THEN "settings"."Role"."permissions"
      ELSE array_append("settings"."Role"."permissions", 'MY_WORKSPACE'::"settings"."Permission")
    END,
    "updatedAt"   = now();

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'MY_WORKSPACE'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261016100000_account_access_completion'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" = 'General User'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;
