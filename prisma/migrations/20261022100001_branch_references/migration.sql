-- 041 company branches (2026-10-22): what points at a branch.
--
--   Project.branchId         the GST registration a project bills from
--   Employee.branchId        the PF / ESIC / PT establishment an employee is filed under
--   PayrollLineItem.branchId the employee's branch when the line was generated — never re-read
--   IssuedLetter.branchId    the registration a letter's header prints (null = head office)
--
-- Everything that exists today belongs to the head office the previous migration created, so the
-- backfill puts it there. Bare ids, no foreign keys: these tables live in other modules' schemas.

SELECT set_config('app.is_super_admin', 'true', true);

ALTER TABLE "projects"."Project" ADD COLUMN "branchId" TEXT;
ALTER TABLE "hr"."Employee" ADD COLUMN "branchId" TEXT;
ALTER TABLE "payroll"."PayrollLineItem" ADD COLUMN "branchId" TEXT;
ALTER TABLE "shared"."IssuedLetter" ADD COLUMN "branchId" TEXT;

UPDATE "projects"."Project" p SET "branchId" = b."id"
FROM "settings"."CompanyBranch" b
WHERE b."companyId" = p."companyId" AND b."isHeadOffice" AND p."branchId" IS NULL;

UPDATE "hr"."Employee" e SET "branchId" = b."id"
FROM "settings"."CompanyBranch" b
WHERE b."companyId" = e."companyId" AND b."isHeadOffice" AND e."branchId" IS NULL;

UPDATE "payroll"."PayrollLineItem" l SET "branchId" = b."id"
FROM "payroll"."PayrollRun" r, "settings"."CompanyBranch" b
WHERE r."id" = l."payrollRunId" AND b."companyId" = r."companyId" AND b."isHeadOffice"
  AND l."branchId" IS NULL;

ALTER TABLE "projects"."Project" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "hr"."Employee" ALTER COLUMN "branchId" SET NOT NULL;

CREATE INDEX "Project_branchId_idx" ON "projects"."Project"("branchId");
CREATE INDEX "Employee_branchId_idx" ON "hr"."Employee"("branchId");
CREATE INDEX "PayrollLineItem_branchId_idx" ON "payroll"."PayrollLineItem"("branchId");
