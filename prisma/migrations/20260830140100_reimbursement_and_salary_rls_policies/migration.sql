-- Row-level security for the three tables 20260830140000_reimbursements_and_salary_slips
-- adds, reusing verbatim the session-variable pattern from
-- 20260830082400_my_workspace_rls_policies (Principle IV).
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL, the same exception features 001–003 already take.

-- Carries companyId directly.

ALTER TABLE "settings"."ReimbursementCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."ReimbursementCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."ReimbursementCategory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- A claim carries its own companyId rather than reaching through Employee, unlike
-- the attendance tables. That is deliberate and not an inconsistency: a claim is a
-- financial document recorded against the company the expense was incurred for, so
-- the value here is the claim's own fact, not a cached copy of the employee's.
ALTER TABLE "hr"."ReimbursementClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."ReimbursementClaim" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."ReimbursementClaim"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- Scoped through the owning Employee, which is itself RLS-protected — the same
-- shape PunchRecord and LeaveApplication use, and for the same reason: a payslip
-- belongs to an employee, and denormalizing a tenant key onto it would create a
-- second place to keep in sync.
ALTER TABLE "payroll"."SalarySlip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."SalarySlip" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."SalarySlip"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "payroll"."SalarySlip"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );
