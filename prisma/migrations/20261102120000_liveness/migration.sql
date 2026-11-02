-- 057: liveness — a server-issued head-turn challenge, a refusal reason, and the scores to calibrate on.

ALTER TYPE "hr"."PunchRefusalReason" ADD VALUE 'liveness_failed';
ALTER TYPE "labour"."LabourPunchRefusalReason" ADD VALUE 'liveness_failed';

ALTER TABLE "hr"."PunchRecord" ADD COLUMN "livenessScore" DECIMAL(5,4);
ALTER TABLE "labour"."LabourPunch" ADD COLUMN "livenessScore" DECIMAL(5,4);
ALTER TABLE "hr"."PunchRefusal"
  ADD COLUMN "livenessScore" DECIMAL(5,4),
  ADD COLUMN "livenessFailure" TEXT;
ALTER TABLE "labour"."LabourPunchRefusal"
  ADD COLUMN "livenessScore" DECIMAL(5,4),
  ADD COLUMN "livenessFailure" TEXT;

-- CreateTable
CREATE TABLE "shared"."LivenessChallenge" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "steps" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LivenessChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LivenessChallenge_expiresAt_idx" ON "shared"."LivenessChallenge"("expiresAt");

-- Not tenant data: read and written only by LivenessService, under the Super Admin context.
ALTER TABLE "shared"."LivenessChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."LivenessChallenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."LivenessChallenge"
  USING (current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_super_admin', true) = 'true');
