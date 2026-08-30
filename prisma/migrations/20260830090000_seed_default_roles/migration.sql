-- Seeds the nine default roles the Settings module requires (002 FR-006).
--
-- This lives in a migration, not in `prisma/seed.ts`, because production needs these
-- rows and `seed.ts` is destructive by design: it deletes every User, UserRole,
-- RefreshToken and AuditLogEntry before seeding, which is correct for a local
-- fixture reset and catastrophic against real data. Running migrations is already
-- part of every deploy (`start:migrate:prod`), so this gets the roles there with no
-- extra step and no destructive script anywhere near production.
--
-- Idempotent: keyed on Role.name's unique constraint, so re-running refreshes each
-- role's permission set without touching its `id` — the UserRole rows that
-- reference it survive untouched. Super Admin already exists (created by
-- 20260828170000_role_permission_model); this simply keeps it current.
--
-- Permission sets are generated from prisma/seeds/settings.seed.ts, which carries
-- the rationale for the three roles the PRD documents by description only
-- (Site Admin, HO User, Site User).

INSERT INTO "settings"."Role" (id, name, permissions, "isProtected", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'Super Admin', ARRAY['DASHBOARD','EMPLOYEES','ATTENDANCE','PROJECTS','DWR','PROJECT_FINANCIALS','MACHINERY','INVENTORY','PARTNERS','REPORTS','PAYROLL','CHALLANS','LOANS','LOGBOOK','FUEL','DAILY_WORKER_REGISTRY','MY_WORKSPACE','SETTINGS','USER_MANAGEMENT','COMPANY_SETTINGS','DATA_EXPORT','DATA_DELETE','CROSS_COMPANY_ACCESS']::"settings"."Permission"[], true, now(), now()),
  (gen_random_uuid()::text, 'Site Admin', ARRAY['DASHBOARD','EMPLOYEES','ATTENDANCE','PROJECTS','DWR','PROJECT_FINANCIALS','MACHINERY','INVENTORY','PARTNERS','REPORTS','PAYROLL','CHALLANS','LOANS','LOGBOOK','FUEL','DAILY_WORKER_REGISTRY','MY_WORKSPACE','SETTINGS','USER_MANAGEMENT','DATA_EXPORT']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'Project Manager', ARRAY['DASHBOARD','EMPLOYEES','ATTENDANCE','PROJECTS','DWR','MACHINERY','REPORTS']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'HO User', ARRAY['DASHBOARD','EMPLOYEES','ATTENDANCE','PROJECTS','DWR','PROJECT_FINANCIALS','MACHINERY','INVENTORY','PARTNERS','REPORTS','PAYROLL','CHALLANS','LOANS','DAILY_WORKER_REGISTRY','USER_MANAGEMENT','DATA_EXPORT']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'Accountant', ARRAY['DASHBOARD','PAYROLL','CHALLANS','LOANS','INVENTORY','REPORTS']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'Site Engineer', ARRAY['DASHBOARD','ATTENDANCE','DWR','MACHINERY','LOGBOOK','FUEL','INVENTORY']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'Store Keeper', ARRAY['DASHBOARD','INVENTORY']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'Site User', ARRAY['DASHBOARD','MY_WORKSPACE','ATTENDANCE']::"settings"."Permission"[], false, now(), now()),
  (gen_random_uuid()::text, 'Viewer', ARRAY['DASHBOARD','REPORTS']::"settings"."Permission"[], false, now(), now())
ON CONFLICT (name) DO UPDATE
SET permissions  = EXCLUDED.permissions,
    "isProtected" = EXCLUDED."isProtected",
    "updatedAt"   = now();
