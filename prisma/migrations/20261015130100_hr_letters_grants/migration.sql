-- Grants `HR_LETTERS` to the roles that are HR (2026-10-15).
--
-- The client's rule: HR issues every letter to an employee, and nobody else does. Super Admin, and
-- HO User — the role the client's HR approval step is mapped to. Deliberately NOT Site Admin,
-- Project Manager or Accountant, who held `EMPLOYEES` / `PAYROLL` and could therefore issue these
-- until now. Any other role can be given it in Settings → Roles.
--
-- Idempotent, as the earlier grants are: `ON CONFLICT DO NOTHING` and the `= ANY` guard.

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT
  gen_random_uuid()::text,
  r."id",
  'HR_LETTERS'::"settings"."Permission",
  levels."level",
  NOW(),
  'migration:20261015130100_hr_letters_grants'
FROM "settings"."Role" r
CROSS JOIN (
  VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")
) AS levels("level")
WHERE r."name" IN ('Super Admin', 'HO User')
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'HR_LETTERS'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" IN ('Super Admin', 'HO User')
  AND NOT ('HR_LETTERS' = ANY (r."permissions"));
