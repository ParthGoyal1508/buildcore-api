-- PROJECT_LOCK for every role that holds PROJECTS today, at the same levels (036 review decision 5).
--
-- Until now any PROJECTS write grant could lock and unlock a project. The new permission narrows
-- that, but defaulting it to nobody (or to Super Admin only) would silently take the ability away
-- from every Project Manager and HO User the morning this deploys. So each role keeps exactly what
-- it could do: a role with PROJECTS read+write gets PROJECT_LOCK read+write; read-only stays
-- read-only (and read-only cannot change the lock, as before). Narrowing it is then a deliberate
-- Settings → Roles change.

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  rp."roleId",
  'PROJECT_LOCK'::"settings"."Permission",
  rp."level",
  NOW(),
  'migration:20261018120001_project_lock_grants'
FROM "settings"."RolePermission" rp
WHERE rp."permission" = 'PROJECTS'::"settings"."Permission"
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- Super Admin always holds everything, whether or not its PROJECTS rows were ever written.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'PROJECT_LOCK'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261018120001_project_lock_grants'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" = 'Super Admin'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- The legacy array (019 phase 2 still reads it for roles without level rows).
UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'PROJECT_LOCK'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE ('PROJECTS' = ANY (r."permissions") OR r."name" = 'Super Admin')
  AND NOT ('PROJECT_LOCK' = ANY (r."permissions"));
