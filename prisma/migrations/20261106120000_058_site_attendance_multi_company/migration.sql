-- 058: site-tagged staff attendance, and all-companies roles.
--
-- 1. A location assignment covers a set of sites and/or projects (new target table) instead of one
--    site. Existing single-site assignments become one target each, then the old column goes.
-- 2. A staff punch records the site it was matched to; a refused punch records the nearest site.
--    Punches accepted in range before 058 are backfilled where the site is certain.
-- 3. `Role.allCompanies`: work in every company of the group without Super Admin's powers.
--
-- The data steps run under the RLS bypass: every hr table here has FORCE ROW LEVEL SECURITY, so
-- without it the migration role would see no rows and the backfill would silently do nothing.
SELECT set_config('app.is_super_admin', 'true', true);

-- ── 1. Assignment targets ────────────────────────────────────────────────────────────────────

CREATE TABLE "hr"."EmployeeLocationAssignmentTarget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "siteId" TEXT,
    "projectId" TEXT,
    CONSTRAINT "EmployeeLocationAssignmentTarget_pkey" PRIMARY KEY ("id"),
    -- A target is a site or a project, never both and never neither.
    CONSTRAINT "EmployeeLocationAssignmentTarget_site_xor_project"
      CHECK (("siteId" IS NULL) <> ("projectId" IS NULL))
);

CREATE INDEX "EmployeeLocationAssignmentTarget_companyId_idx"
  ON "hr"."EmployeeLocationAssignmentTarget"("companyId");
CREATE INDEX "EmployeeLocationAssignmentTarget_assignmentId_idx"
  ON "hr"."EmployeeLocationAssignmentTarget"("assignmentId");
CREATE UNIQUE INDEX "EmployeeLocationAssignmentTarget_assignmentId_siteId_projec_key"
  ON "hr"."EmployeeLocationAssignmentTarget"("assignmentId", "siteId", "projectId");

ALTER TABLE "hr"."EmployeeLocationAssignmentTarget"
  ADD CONSTRAINT "EmployeeLocationAssignmentTarget_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "hr"."EmployeeLocationAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hr"."EmployeeLocationAssignmentTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."EmployeeLocationAssignmentTarget" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."EmployeeLocationAssignmentTarget"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- Every existing single-site assignment becomes one site target.
INSERT INTO "hr"."EmployeeLocationAssignmentTarget" ("id", "companyId", "assignmentId", "siteId")
SELECT 'm058' || a."id", a."companyId", a."id", a."siteId"
FROM "hr"."EmployeeLocationAssignment" a
WHERE a."siteId" IS NOT NULL;

-- ── 2. Punch site ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "hr"."PunchRecord" ADD COLUMN "siteId" TEXT;
CREATE INDEX "PunchRecord_siteId_punchDate_idx" ON "hr"."PunchRecord"("siteId", "punchDate");
ALTER TABLE "hr"."PunchRefusal" ADD COLUMN "siteId" TEXT;

-- Backfill (FR-015): only where the site is certain — an employee's own punch, accepted in range,
-- checked against the single site in force that day. That site is the assignment's (unless it
-- was mobile, in which case nothing was checked and the punch stays blank), else the employee's
-- own site, which is what the punch service fell back to. Admin and imported punches were never
-- located, so they stay blank. Must run before the assignment's `siteId` column is dropped.
UPDATE "hr"."PunchRecord" pr
SET "siteId" = resolved."siteId"
FROM (
  SELECT p."id",
         CASE
           WHEN a."id" IS NULL THEN e."siteId"
           WHEN a."isMobile" THEN NULL
           ELSE a."siteId"
         END AS "siteId"
  FROM "hr"."PunchRecord" p
  JOIN "hr"."Employee" e ON e."id" = p."employeeId"
  LEFT JOIN LATERAL (
    SELECT la."id", la."siteId", la."isMobile"
    FROM "hr"."EmployeeLocationAssignment" la
    WHERE la."employeeId" = p."employeeId"
      AND la."effectiveFrom" <= p."punchDate"
    ORDER BY la."effectiveFrom" DESC, la."createdAt" DESC
    LIMIT 1
  ) a ON true
  WHERE p."geofenceResult" = 'in_range'
    AND p."source" = 'employee'
    AND p."siteId" IS NULL
) resolved
WHERE resolved."id" = pr."id"
  AND resolved."siteId" IS NOT NULL;

-- The old single-site column and its check go; "mobile or at least one target" is enforced by the
-- service, because a check constraint cannot look across rows.
ALTER TABLE "hr"."EmployeeLocationAssignment"
  DROP CONSTRAINT "EmployeeLocationAssignment_site_or_mobile";
ALTER TABLE "hr"."EmployeeLocationAssignment" DROP COLUMN "siteId";

-- ── 3. All-companies roles ───────────────────────────────────────────────────────────────────

ALTER TABLE "settings"."Role" ADD COLUMN "allCompanies" BOOLEAN NOT NULL DEFAULT false;
