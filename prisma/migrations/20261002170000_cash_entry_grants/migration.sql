-- 019 FR-017b (task T075): grant `CASH_ENTRY` to every role that can already record a cash
-- payment, so this feature changes who *may* take cash in future without changing who can
-- take it today.
--
-- **Preserving today's behaviour is the requirement, not a convenience.** A permission that
-- defaults to nobody stops every site cashier in every company the moment it deploys — the
-- exact failure the two-control design existed to avoid. So the grant is derived from the
-- authorisation that gates the two cash-capable writes as they stand:
--
--   * `POST inventory/payments`                        → Permission.INVENTORY, write
--   * `PATCH labour/payment-sheets/lines/:id/disburse` → Permission.DAILY_WORKER_REGISTRY, write
--
-- A role holding either of those at `write` can record a cash payment now, so it holds
-- `CASH_ENTRY` after this runs. Read-level holders are deliberately excluded: they cannot
-- record a payment of any mode, so granting them cash entry would widen access rather than
-- preserve it.
--
-- **Both levels, and the split is real.** `write` is the right to record a payment in cash
-- (FR-017a); `read` is the right to see a cash denomination breakup (FR-017d). Granting write
-- alone would also trip the `WRITE_WITHOUT_READ` rule in `RolesService` the next time anybody
-- edited one of these roles through the interface — and that rule is right here for its usual
-- reason: being allowed to pay out notes while not being allowed to see the breakup you are
-- paying against is not a coherent grant.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  roles."roleId",
  'CASH_ENTRY'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261002170000_cash_entry_grants'
FROM (
  SELECT DISTINCT rp."roleId"
  FROM "settings"."RolePermission" rp
  WHERE rp."permission" IN ('INVENTORY', 'DAILY_WORKER_REGISTRY')
    AND rp."level" = 'write'
) roles
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- `Role.permissions` is still what every service-level `permissions.includes(...)` reads, and
-- `RolesService.create`/`update` write the array and the rows together for that reason. A
-- backfill that wrote only the rows would leave the two disagreeing — the guard granting cash
-- entry and a service check denying it — so the array is updated in the same migration.
UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'CASH_ENTRY'::"settings"."Permission")
WHERE NOT ('CASH_ENTRY' = ANY (r."permissions"))
  AND EXISTS (
    SELECT 1
    FROM "settings"."RolePermission" rp
    WHERE rp."roleId" = r."id"
      AND rp."permission" = 'CASH_ENTRY'
  );
