-- Row-level security for the tables feature 005 adds, reusing verbatim the
-- session-variable pattern established in 20260829073000_settings_rls_policies and
-- 20260830082400_my_workspace_rls_policies, set by src/common/prisma/rls-context.ts
-- (Principle IV).
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception features 001-003 already take.
--
-- Scoping follows 003's rule and its rationale: a table that belongs to an employee
-- is scoped THROUGH that employee rather than carrying a copied companyId, because a
-- duplicated tenant key is a second source of truth that US8 (transfer an employee
-- between companies) would have to remember to rewrite. Two deliberate exceptions
-- are documented inline below.

-- ── Company-level tables: direct companyId ──────────────────────────────────

ALTER TABLE "hr"."Holiday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."Holiday" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."Holiday"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- EXCEPTION 1: Loan keeps its own companyId. A loan is a financial obligation
-- issued *by a company*; US8's transfer must not hand visibility of an outstanding
-- debt to the destination tenant, so it is deliberately NOT scoped through Employee.
ALTER TABLE "payroll"."Loan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."Loan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."Loan"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── Employee-owned tables: scoped through the owning Employee ───────────────
-- Each is indexed on employeeId and hr.Employee is indexed on companyId, so the
-- EXISTS stays an index lookup. The subquery reads the Employee row, itself
-- RLS-protected, so it cannot be satisfied by an employee the caller may not see.

ALTER TABLE "hr"."EmployeeDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."EmployeeDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."EmployeeDocument"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."EmployeeDocument"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."EmployeeTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."EmployeeTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."EmployeeTransfer"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."EmployeeTransfer"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."AttendanceModification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."AttendanceModification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."AttendanceModification"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."AttendanceModification"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "hr"."ExitRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."ExitRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."ExitRecord"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."ExitRecord"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- EXCEPTION 2: PayrollLineItem is scoped through its PayrollRun, not its Employee.
-- Payroll history belongs to the company that ran it; after US8 transfers an
-- employee, last month's payslip must stay with the company that paid it rather
-- than following the employee into the destination tenant.
ALTER TABLE "payroll"."PayrollLineItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."PayrollLineItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."PayrollLineItem"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "payroll"."PayrollRun" r
      WHERE r."id" = "payroll"."PayrollLineItem"."payrollRunId"
        AND r."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- LoanScheduleEntry is scoped through its Loan (which carries companyId above).
ALTER TABLE "payroll"."LoanScheduleEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."LoanScheduleEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."LoanScheduleEntry"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "payroll"."Loan" l
      WHERE l."id" = "payroll"."LoanScheduleEntry"."loanId"
        AND l."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- HolidaySite is scoped through its Holiday (which carries companyId above).
ALTER TABLE "hr"."HolidaySite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hr"."HolidaySite" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hr"."HolidaySite"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Holiday" h
      WHERE h."id" = "hr"."HolidaySite"."holidayId"
        AND h."companyId" = current_setting('app.current_company_id', true)
    )
  );
