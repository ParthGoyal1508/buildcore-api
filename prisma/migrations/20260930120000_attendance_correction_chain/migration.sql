-- 016 Phase 8, 2026-09-30. The manual attendance correction enters the approval chain.
--
-- Two things: the table a submitted-but-unapplied correction lives in, and the chain it
-- enters, seeded for every company that already exists.
--
-- Why a table at all: `shared.ApprovalInstance` carries no payload by design — it holds an
-- opaque (entityType, entityId) pair and never dereferences it, which is what lets the
-- spine know nothing about the modules it serves. So a correction's intended values have
-- to live in `hr`, owned by the module that understands them, and the spine points at
-- them. Neither the plan nor the task list named this table; it was found during
-- implementation, because "submit and return the pending instance" has nowhere to keep the
-- correction otherwise.

-- ── RLS context for the data statements below ────────────────────────────────
--
-- The chain seed writes one ApprovalChain and three ApprovalLevel rows per existing
-- company. Production connects as `buildcore_app` (NOSUPERUSER, NOBYPASSRLS) where
-- `shared.ApprovalChain`'s tenant_isolation policy fires; local development connects as a
-- SUPERUSER and bypasses RLS entirely, which is why this class of defect cannot be caught
-- by running migrations locally.
--
-- Without this line the INSERTs below are refused (42501) or match nothing, and the
-- symptom is every manual attendance correction failing with "no active approval chain is
-- configured" in every company at once. Five migrations failed this way in production on
-- 2026-09-16.
SELECT set_config('app.is_super_admin', 'true', true);

CREATE TABLE "hr"."PendingAttendanceCorrection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "approvalInstanceId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- One correction per approval instance. The spine's entityId points here, so two rows for
-- one instance would make "which correction did this approval apply?" ambiguous at exactly
-- the moment it is applied.
CREATE UNIQUE INDEX "PendingAttendanceCorrection_approvalInstanceId_key"
  ON "hr"."PendingAttendanceCorrection"("approvalInstanceId");

CREATE INDEX "PendingAttendanceCorrection_companyId_employeeId_date_idx"
  ON "hr"."PendingAttendanceCorrection"("companyId", "employeeId", "date");

ALTER TABLE "hr"."PendingAttendanceCorrection"
  ADD CONSTRAINT "PendingAttendanceCorrection_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation. WITH CHECK written explicitly rather than left to default from USING:
-- Postgres reuses USING as the WITH CHECK expression when it is omitted, which works but
-- means a later edit to one silently changes the other.
ALTER TABLE "hr"."PendingAttendanceCorrection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."PendingAttendanceCorrection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."PendingAttendanceCorrection"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- ── The chain, for every company that already exists ────────────────────────
--
-- `seedDefaultsForCompany` covers companies created from now on. This covers the ones
-- already here, and is idempotent on (companyId, actionType) so re-running it is safe.
--
-- Shape copied from the attendance-exception chain: Site / Employer → HR → Director, which
-- is the shape the client described in Note 2. The slot keys are what each company maps to
-- its own roles, so nothing here assumes an org chart.
INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", 'attendance_correction', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "settings"."Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "shared"."ApprovalChain" ac
  WHERE ac."companyId" = c."id" AND ac."actionType" = 'attendance_correction'
);

INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "label", "isFinalAuthority", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  ac."id",
  ac."companyId",
  l."position",
  l."slotKey",
  l."label",
  l."isFinalAuthority",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "shared"."ApprovalChain" ac
CROSS JOIN (VALUES
  (1, 'first_approver', 'Site / Employer', false),
  (2, 'hr',             'HR',             false),
  (3, 'final',          'Director',       true)
) AS l("position", "slotKey", "label", "isFinalAuthority")
WHERE ac."actionType" = 'attendance_correction'
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" al
    WHERE al."chainId" = ac."id" AND al."position" = l."position"
  );
