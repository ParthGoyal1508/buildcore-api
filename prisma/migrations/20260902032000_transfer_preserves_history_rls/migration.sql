-- Pre-transfer history stays visible to the company the employee worked for
-- (005 FR-007, US8).
--
-- The problem: employee-owned tables are scoped through `hr.Employee.companyId`
-- (the pattern 003 established, and the right one — see that migration's note on
-- why a denormalised tenant key is worse). But US8's transfer *changes* that
-- column, so the moment an employee moves companies, every punch and leave
-- application they ever filed silently becomes invisible to the company they
-- actually worked for and visible to one that never employed them at the time.
--
-- FR-007 requires the opposite: "preserving pre-transfer historical records under
-- the original company".
--
-- The fix is to widen the policy, not the schema. `hr.EmployeeTransfer` already
-- records the boundary — who moved, from where, on what date — so a row dated
-- before a transfer out of the current company is still that company's record.
-- No column is copied, so there is still exactly one source of truth for tenancy.
--
-- Applied to the two genuinely historical tables. Documents are deliberately NOT
-- included: an employee's ID proof is current state that should follow them, not a
-- record of something that happened on a date.

DROP POLICY "tenant_isolation" ON "hr"."PunchRecord";
CREATE POLICY "tenant_isolation" ON "hr"."PunchRecord"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."PunchRecord"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
    -- ... or the employee was in this company on the day of the punch, and has
    -- since been transferred out.
    OR EXISTS (
      SELECT 1 FROM "hr"."EmployeeTransfer" t
      WHERE t."employeeId" = "hr"."PunchRecord"."employeeId"
        AND t."fromCompanyId" = current_setting('app.current_company_id', true)
        AND "hr"."PunchRecord"."punchDate" < t."transferDate"
    )
  );

DROP POLICY "tenant_isolation" ON "hr"."LeaveApplication";
CREATE POLICY "tenant_isolation" ON "hr"."LeaveApplication"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "hr"."Employee" e
      WHERE e."id" = "hr"."LeaveApplication"."employeeId"
        AND e."companyId" = current_setting('app.current_company_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM "hr"."EmployeeTransfer" t
      WHERE t."employeeId" = "hr"."LeaveApplication"."employeeId"
        AND t."fromCompanyId" = current_setting('app.current_company_id', true)
        AND "hr"."LeaveApplication"."fromDate" < t."transferDate"
    )
  );

-- Supports the added EXISTS lookups.
CREATE INDEX "EmployeeTransfer_employeeId_fromCompanyId_idx"
  ON "hr"."EmployeeTransfer" ("employeeId", "fromCompanyId");
