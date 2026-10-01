-- 020 Phase 2, 2026-09-30. Recording refused punches (FR-013c).
--
-- **This phase changes no user-visible behaviour.** Its output is a number: how often a punch would
-- be refused if FR-013's hard block were switched on. The client accepted that block's cost without
-- such a number, and Phase 3 does not begin until they have seen one — which is the obligation this
-- table exists to discharge while the decision is still reversible.
--
-- Additive, no backfill, no data statement, so no `set_config` guard.
--
-- **No photo column**, deliberately. A face-mismatch refusal means the system could not establish
-- whose face it is; retaining an unattributed biometric against a named employee is worse than the
-- exception record it replaces. The face-match distance is kept, because a number is not a biometric.

CREATE TYPE "hr"."PunchRefusalReason" AS ENUM (
  'outside_geofence',
  'unlocatable',
  'face_mismatch',
  'no_face_detected'
);

CREATE TABLE "hr"."PunchRefusal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "hr"."PunchType" NOT NULL,
    "reason" "hr"."PunchRefusalReason" NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "distanceMeters" DECIMAL(12,2),
    "accuracyMeters" INTEGER,
    "faceMatchDistance" DECIMAL(6,4),
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PunchRefusal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PunchRefusal_companyId_createdAt_idx"
  ON "hr"."PunchRefusal"("companyId", "createdAt");

-- The employee-and-date index is what makes "show me this worker's refused punches for September"
-- cheap — the query somebody runs when a worker says they were marked absent for a day they worked.
CREATE INDEX "PunchRefusal_companyId_employeeId_capturedAt_idx"
  ON "hr"."PunchRefusal"("companyId", "employeeId", "capturedAt");

ALTER TABLE "hr"."PunchRefusal"
  ADD CONSTRAINT "PunchRefusal_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- This table holds location and failed-verification facts about a named person, which is more
-- sensitive than the punch it stands in for. WITH CHECK written explicitly rather than left to
-- default from USING.
ALTER TABLE "hr"."PunchRefusal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."PunchRefusal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."PunchRefusal"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
