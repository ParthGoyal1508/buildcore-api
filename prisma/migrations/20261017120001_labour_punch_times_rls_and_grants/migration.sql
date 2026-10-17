-- Row-level security for 034's two new labour tables, and `LABOUR_PUNCH_CORRECT` for the roles that
-- already approve labour: Super Admin, Site Admin and HO User (the three that hold LABOUR_APPROVE,
-- 20260906120000). A supervisor role gets it by an administrator adding it under Settings → Roles.
-- Separate from 20261017120000 because Postgres will not use an enum value in the transaction that
-- added it.

ALTER TABLE "labour"."LabourPunchCorrection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourPunchCorrection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourPunchCorrection"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourSitePhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourSitePhoto" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourSitePhoto"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'LABOUR_PUNCH_CORRECT'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261017120001_labour_punch_times_rls_and_grants'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" IN ('Super Admin', 'Site Admin', 'HO User')
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'LABOUR_PUNCH_CORRECT'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" IN ('Super Admin', 'Site Admin', 'HO User')
  AND NOT ('LABOUR_PUNCH_CORRECT' = ANY (r."permissions"));
