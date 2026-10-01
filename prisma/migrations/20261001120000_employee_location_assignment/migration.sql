-- 020 Phase 4, 2026-10-01. Per-employee geofence assignment (FR-011, FR-014, FR-016).
--
-- **Deployable on a live system with no backfill and no behaviour change.** An employee with no row
-- here is validated against their site's geofence exactly as before, which is every employee the day
-- this ships. That fallback is FR-016, and it is why introducing the table refuses nobody — the
-- alternative, requiring an assignment, would deny attendance company-wide on the first morning.
--
-- Additive, no data statement, so no `set_config` guard.

CREATE TABLE "hr"."EmployeeLocationAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "siteId" TEXT,
    "isMobile" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" DATE NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeLocationAssignment_pkey" PRIMARY KEY ("id")
);

-- The resolution query's access path: the greatest `effectiveFrom` at or before a punch's day.
CREATE INDEX "EmployeeLocationAssignment_employeeId_effectiveFrom_idx"
  ON "hr"."EmployeeLocationAssignment"("employeeId", "effectiveFrom");

ALTER TABLE "hr"."EmployeeLocationAssignment"
  ADD CONSTRAINT "EmployeeLocationAssignment_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- An assignment naming no site and claiming no exemption is a row that validates nothing, and the
-- reader who meets it cannot tell whether it is an exemption or an unfinished edit. Enforced in the
-- database rather than in a service, because the service is not the only thing that will ever write
-- here — a seed, a migration or a console session is.
ALTER TABLE "hr"."EmployeeLocationAssignment"
  ADD CONSTRAINT "EmployeeLocationAssignment_site_or_mobile"
  CHECK ("siteId" IS NOT NULL OR "isMobile");

-- Where a named person may be required to be. WITH CHECK written explicitly rather than left to
-- default from USING, as everywhere else in this schema.
ALTER TABLE "hr"."EmployeeLocationAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."EmployeeLocationAssignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."EmployeeLocationAssignment"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
