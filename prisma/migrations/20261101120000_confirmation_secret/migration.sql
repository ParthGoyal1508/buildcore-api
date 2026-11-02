-- 054: App Settings is confirmed with its own password, set only by a backend script.

-- CreateTable
CREATE TABLE "shared"."ConfirmationSecret" (
    "purpose" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfirmationSecret_pkey" PRIMARY KEY ("purpose")
);

-- Read only under the Super Admin context (the service checks the caller first), and written
-- only by prisma/rotate-settings-password.ts — never by a tenant query.
ALTER TABLE "shared"."ConfirmationSecret" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ConfirmationSecret" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ConfirmationSecret"
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');
