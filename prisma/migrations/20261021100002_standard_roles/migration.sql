-- The client's standard roles (2026-10-20). Super Admin is role 0 and already exists; these are 1–6.
--
--   1 Operations Manager — every module except Dashboard
--   2 Accounts & Admin   — every module except Projects and Dashboard
--   3 Site Operations    — every module except Projects, Dashboard, Reports and HR & Payroll
--   4 DWR Entry          — DWR and My Workspace
--   5 Labour Supervisor  — Labour and My Workspace
--   6 Storekeeper        — Inventory and My Workspace
--
-- "Every module" carries that module's approval and payment rights (the client's answer), and
-- Settings for masters only: user and role management, company settings, data delete, cross-company
-- access and machine disposal stay with Super Admin, so no role here can make itself Super Admin.
-- Roles 4–6 are the doing permission alone; approvals stay with the roles above them.
--
-- Global roles (companyId null), like the four that exist. Idempotent by name, so a company that
-- already made a role with one of these names keeps it as it is.

SELECT set_config('app.is_super_admin', 'true', true);

-- Role 1: every module except Dashboard, with its approvals and payments; Settings for masters only.
INSERT INTO "settings"."Role" ("id", "name", "companyId", "permissions", "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'Operations Manager', NULL, ARRAY['MY_WORKSPACE', 'PARTNERS', 'SETTINGS', 'CASH_ENTRY', 'EMPLOYEES', 'ATTENDANCE', 'PAYROLL', 'CHALLANS', 'LOANS', 'HR_LETTERS', 'PROJECTS', 'PROJECT_FINANCIALS', 'PROJECT_LOCK', 'BANK_GUARANTEES', 'DWR', 'MACHINERY', 'LOGBOOK', 'FUEL', 'MAINTENANCE', 'HIRE_BILLS', 'MAINTENANCE_PAY', 'INVENTORY', 'INVENTORY_APPROVE', 'DAILY_WORKER_REGISTRY', 'LABOUR_APPROVE', 'LABOUR_PUNCH_CORRECT', 'RECRUITMENT', 'RECRUITMENT_APPROVE', 'ASSETS', 'ASSETS_APPROVE', 'REPORTS', 'DATA_EXPORT']::"settings"."Permission"[], false, false, NULL, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "settings"."Role" WHERE "name" = 'Operations Manager');

-- Role 2: as Operations Manager, without Projects (and so without DWR and bank guarantees).
INSERT INTO "settings"."Role" ("id", "name", "companyId", "permissions", "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'Accounts & Admin', NULL, ARRAY['MY_WORKSPACE', 'PARTNERS', 'SETTINGS', 'CASH_ENTRY', 'EMPLOYEES', 'ATTENDANCE', 'PAYROLL', 'CHALLANS', 'LOANS', 'HR_LETTERS', 'MACHINERY', 'LOGBOOK', 'FUEL', 'MAINTENANCE', 'HIRE_BILLS', 'MAINTENANCE_PAY', 'INVENTORY', 'INVENTORY_APPROVE', 'DAILY_WORKER_REGISTRY', 'LABOUR_APPROVE', 'LABOUR_PUNCH_CORRECT', 'RECRUITMENT', 'RECRUITMENT_APPROVE', 'ASSETS', 'ASSETS_APPROVE', 'REPORTS', 'DATA_EXPORT']::"settings"."Permission"[], false, false, NULL, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "settings"."Role" WHERE "name" = 'Accounts & Admin');

-- Role 3: as Accounts & Admin, without Reports and HR & Payroll.
INSERT INTO "settings"."Role" ("id", "name", "companyId", "permissions", "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'Site Operations', NULL, ARRAY['MY_WORKSPACE', 'PARTNERS', 'SETTINGS', 'CASH_ENTRY', 'MACHINERY', 'LOGBOOK', 'FUEL', 'MAINTENANCE', 'HIRE_BILLS', 'MAINTENANCE_PAY', 'INVENTORY', 'INVENTORY_APPROVE', 'DAILY_WORKER_REGISTRY', 'LABOUR_APPROVE', 'LABOUR_PUNCH_CORRECT', 'RECRUITMENT', 'RECRUITMENT_APPROVE', 'ASSETS', 'ASSETS_APPROVE']::"settings"."Permission"[], false, false, NULL, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "settings"."Role" WHERE "name" = 'Site Operations');

-- Role 4: daily work reports and My Workspace only.
INSERT INTO "settings"."Role" ("id", "name", "companyId", "permissions", "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'DWR Entry', NULL, ARRAY['DWR', 'MY_WORKSPACE']::"settings"."Permission"[], false, false, NULL, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "settings"."Role" WHERE "name" = 'DWR Entry');

-- Role 5: Labour and My Workspace only.
INSERT INTO "settings"."Role" ("id", "name", "companyId", "permissions", "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'Labour Supervisor', NULL, ARRAY['DAILY_WORKER_REGISTRY', 'MY_WORKSPACE']::"settings"."Permission"[], false, false, 'labour', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "settings"."Role" WHERE "name" = 'Labour Supervisor');

-- Role 6: Inventory and My Workspace only.
INSERT INTO "settings"."Role" ("id", "name", "companyId", "permissions", "isProtected", "isDefault", "homeModule", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'Storekeeper', NULL, ARRAY['INVENTORY', 'MY_WORKSPACE']::"settings"."Permission"[], false, false, 'inventory', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "settings"."Role" WHERE "name" = 'Storekeeper');

-- Read and write rows for every permission each role was created with above. Only for roles this
-- migration created (their array is exactly what it set), so a pre-existing role of the same name
-- is not widened.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT gen_random_uuid()::text, r."id", p.perm, levels."level", NOW(), 'migration:20261021100002_standard_roles'
FROM "settings"."Role" r
CROSS JOIN LATERAL unnest(r."permissions") AS p(perm)
CROSS JOIN (VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")) AS levels("level")
WHERE r."name" IN ('Operations Manager', 'Accounts & Admin', 'Site Operations', 'DWR Entry', 'Labour Supervisor', 'Storekeeper')
  AND NOT EXISTS (SELECT 1 FROM "settings"."RolePermission" x WHERE x."roleId" = r."id")
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- Site Incharge raises job cards (039: "the Site In-charge creates the Job Card"), which needs
-- MAINTENANCE; the default Site Incharge role never had it.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT gen_random_uuid()::text, r."id", 'MAINTENANCE'::"settings"."Permission", levels."level", NOW(), 'migration:20261021100002_standard_roles'
FROM "settings"."Role" r
CROSS JOIN (VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")) AS levels("level")
WHERE r."name" = 'Site Incharge'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'MAINTENANCE'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" = 'Site Incharge'
  AND NOT ('MAINTENANCE' = ANY (r."permissions"));
