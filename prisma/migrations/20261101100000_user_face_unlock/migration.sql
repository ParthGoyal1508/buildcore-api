-- 054: a signed-in account's own face, for confirming a sensitive act without the password.

-- CreateTable
CREATE TABLE "shared"."UserFaceUnlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "descriptor" BYTEA NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFaceUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserFaceUnlock_userId_key" ON "shared"."UserFaceUnlock"("userId");

-- AddForeignKey
ALTER TABLE "shared"."UserFaceUnlock" ADD CONSTRAINT "UserFaceUnlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "shared"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Biometric data: read and written only under the Super Admin context (the service always uses
-- it, having checked the caller itself), never by an ordinary tenant query.
ALTER TABLE "shared"."UserFaceUnlock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."UserFaceUnlock" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."UserFaceUnlock"
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');
