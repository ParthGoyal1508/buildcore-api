-- 058 US4: the role named "Labour Supervisor" registers labour and marks attendance, nothing more
-- (the client, 2026-11-07). It swaps DAILY_WORKER_REGISTRY for LABOUR_ATTENDANCE, keeping the
-- levels it had. No other role changes: those that also hold labour approvals keep full labour
-- management, and the client narrows anything else in Settings -> Roles.
SELECT set_config('app.is_super_admin', 'true', true);

-- The level rows first, while the old value still identifies them.
UPDATE "settings"."RolePermission" rp
SET "permission" = 'LABOUR_ATTENDANCE'
FROM "settings"."Role" r
WHERE rp."roleId" = r."id"
  AND r."name" = 'Labour Supervisor'
  AND rp."permission" = 'DAILY_WORKER_REGISTRY'
  AND NOT EXISTS (
    SELECT 1 FROM "settings"."RolePermission" x
    WHERE x."roleId" = rp."roleId" AND x."permission" = 'LABOUR_ATTENDANCE' AND x."level" = rp."level"
  );

UPDATE "settings"."Role"
SET "permissions" = array_replace("permissions", 'DAILY_WORKER_REGISTRY'::"settings"."Permission", 'LABOUR_ATTENDANCE'::"settings"."Permission"),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "name" = 'Labour Supervisor'
  AND 'DAILY_WORKER_REGISTRY' = ANY("permissions");
