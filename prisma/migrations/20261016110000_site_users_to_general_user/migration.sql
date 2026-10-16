-- Employee logins stop seeing everybody's attendance and leave (2026-10-16 access-control audit, H2).
--
-- Employee logins were given "Site User", which carries ATTENDANCE: that opened the whole company's
-- daily attendance, every employee's leave applications and balances, and leave approval — their own
-- included. The client's decision (2026-10-16): employees hold "General User" — My Workspace only —
-- and Site User loses ATTENDANCE.
--
-- "General User" is also created by 20261016100000_account_access_completion (029, a parallel
-- branch), which adds its home-module and default flags. Either migration may run first: this one
-- inserts only the columns that exist without 029 and does nothing if the role is already there.

INSERT INTO "settings"."Role" (id, name, permissions, "isProtected", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'General User', ARRAY['MY_WORKSPACE']::"settings"."Permission"[], false, now(), now())
ON CONFLICT (name) DO NOTHING;

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT gen_random_uuid()::text, r."id", 'MY_WORKSPACE'::"settings"."Permission", lvl::"settings"."AccessLevel", now(), 'migration:20261016110000'
FROM "settings"."Role" r
CROSS JOIN (VALUES ('read'), ('write')) AS levels(lvl)
WHERE r."name" = 'General User'
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- UserRole FORCEs row-level security and production migrates as a NOSUPERUSER role, so moving
-- every company's accounts needs the super-admin escape hatch (transaction-local), as in
-- 20261016000000_plant_store_documents.
SELECT set_config('app.is_super_admin', 'true', true);

-- Every Site User account now holds General User instead. An account already holding General User
-- keeps that one assignment (the pair is unique); either way its Site User assignment goes.
INSERT INTO "settings"."UserRole" ("id", "userId", "roleId", "companyId", "createdAt")
SELECT gen_random_uuid()::text, ur."userId", gu."id", ur."companyId", now()
FROM "settings"."UserRole" ur
JOIN "settings"."Role" su ON su."id" = ur."roleId" AND su."name" = 'Site User'
CROSS JOIN "settings"."Role" gu
WHERE gu."name" = 'General User'
ON CONFLICT ("userId", "roleId") DO NOTHING;

DELETE FROM "settings"."UserRole" ur
USING "settings"."Role" su
WHERE su."id" = ur."roleId" AND su."name" = 'Site User';

-- And Site User itself no longer grants ATTENDANCE, should anyone be given it again.
UPDATE "settings"."Role"
SET permissions = array_remove(permissions, 'ATTENDANCE'::"settings"."Permission"), "updatedAt" = now()
WHERE name = 'Site User';

DELETE FROM "settings"."RolePermission" rp
USING "settings"."Role" r
WHERE r."id" = rp."roleId" AND r."name" = 'Site User' AND rp."permission" = 'ATTENDANCE';
