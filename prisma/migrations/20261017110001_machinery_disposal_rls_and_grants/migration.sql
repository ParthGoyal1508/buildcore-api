-- Row-level security for the two disposal tables, and MACHINERY_DISPOSE for Super Admin only
-- (2026-10-17: "Super Admin can do it"). Any other role can be given it in Settings → Roles.

ALTER TABLE "plant"."EquipmentDisposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."EquipmentDisposal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."EquipmentDisposal"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."EquipmentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."EquipmentEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."EquipmentEvent"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'MACHINERY_DISPOSE'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261017110001_machinery_disposal_rls_and_grants'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" = 'Super Admin'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'MACHINERY_DISPOSE'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" = 'Super Admin'
  AND NOT ('MACHINERY_DISPOSE' = ANY (r."permissions"));
