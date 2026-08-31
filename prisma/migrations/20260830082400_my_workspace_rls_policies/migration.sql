-- Row-level security for the companyId-scoped tables feature 003 adds, reusing
-- verbatim the session-variable pattern established in
-- 20260828162304_multi_schema_and_auth_extensions and 20260829073000_settings_rls_policies,
-- and set by src/common/prisma/rls-context.ts (Principle IV).
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL rather than generated DDL — the same exception
-- features 001 and 002 already take.

-- Tables carrying companyId directly.

ALTER TABLE "projects"."Site" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."Site" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."Site"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "hr"."Employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."Employee" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."Employee"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "payroll"."PayrollRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."PayrollRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."PayrollRun"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- Tables with no companyId of their own, scoped through the Employee that owns them.
--
-- These deliberately do NOT denormalize a companyId column just to make the policy
-- a simple equality. A copied tenant key is a second source of truth that a later
-- transfer-employee-between-companies feature would have to remember to update in
-- five places; getting that wrong leaks attendance across tenants, which is exactly
-- the failure RLS exists to prevent. The EXISTS subquery reads the owning Employee
-- row, which is itself RLS-protected above, so the check cannot be satisfied by an
-- employee the caller may not see. `hr"."Employee` is indexed on companyId, and each
-- table below is indexed on employeeId, so this stays an index lookup.

ALTER TABLE "hr"."FaceEnrolment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."FaceEnrolment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."FaceEnrolment"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."FaceEnrolment"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."ReEnrolmentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."ReEnrolmentRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."ReEnrolmentRequest"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."ReEnrolmentRequest"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."PunchRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."PunchRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."PunchRecord"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."PunchRecord"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."LeaveBalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."LeaveBalance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."LeaveBalance"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."LeaveBalance"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."LeaveApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."LeaveApplication" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."LeaveApplication"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."LeaveApplication"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- FR-008's "at most one open punch-in per employee" is enforced transactionally in
-- PunchService (research.md §5). This partial unique index is the database-level
-- backstop for the same rule: a punch-in is "open" until its punch-out lands, and
-- PunchService marks that by setting "closedByPunchId". Two concurrent punch-ins
-- that both passed the application check would collide here rather than both
-- landing, which is the race a check-then-insert cannot close on its own.
CREATE UNIQUE INDEX "PunchRecord_one_open_punch_in_per_employee"
  ON "hr"."PunchRecord" ("employeeId")
  WHERE "type" = 'in' AND "closedByPunchId" IS NULL;
