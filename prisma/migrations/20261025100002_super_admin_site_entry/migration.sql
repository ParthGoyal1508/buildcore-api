-- 043 follow-up: Super Admin holds every permission, as each new one's migration has granted it.
-- `20261025100001_site_purchase_entries` granted INVENTORY_SITE_ENTRY to Site Incharge only, so Super
-- Admin could not open the site delivery page. Its own migration, because that one has already run.
SELECT set_config('app.is_super_admin', 'true', true);

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT gen_random_uuid()::text, r."id", 'INVENTORY_SITE_ENTRY'::"settings"."Permission", levels."level", NOW(), 'migration:20261025100002_super_admin_site_entry'
FROM "settings"."Role" r
CROSS JOIN (VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")) AS levels("level")
WHERE r."name" = 'Super Admin'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'INVENTORY_SITE_ENTRY'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" = 'Super Admin'
  AND NOT ('INVENTORY_SITE_ENTRY' = ANY (r."permissions"));
