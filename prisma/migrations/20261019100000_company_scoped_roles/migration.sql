-- 036 C10: custom roles belong to a company.
--
-- Roles were global, so a company administrator's "Site Supervisor" appeared in every other
-- company's role list, and the duplicate-name refusal told one company the names another had
-- chosen. A role now carries the company it was made in; the system roles (Super Admin, General
-- User and the other seeded defaults) stay global (companyId NULL) and every company shares them.

-- AlterTable
ALTER TABLE "settings"."Role" ADD COLUMN "companyId" TEXT;

-- CreateIndex
CREATE INDEX "Role_companyId_idx" ON "settings"."Role"("companyId");

-- AddForeignKey
ALTER TABLE "settings"."Role" ADD CONSTRAINT "Role_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Names: unique among the global roles, and within each company's own. Two partial indexes,
-- because a plain (companyId, name) index treats every NULL company as distinct and would let two
-- global roles share a name. Prisma cannot express either, so the schema carries none.
DROP INDEX "settings"."Role_name_key";
CREATE UNIQUE INDEX "Role_global_name_key" ON "settings"."Role"("name") WHERE "companyId" IS NULL;
CREATE UNIQUE INDEX "Role_company_name_key" ON "settings"."Role"("companyId", "name") WHERE "companyId" IS NOT NULL;

-- Backfill: an existing custom role moves to the company of its holders, where that is
-- unambiguous — every holder is an account of one and the same company, and none is a
-- cross-company account (companyId NULL). Anything else stays global and is counted below:
--   * a system role (protected, the default, or one of the seeded names);
--   * a role nobody holds (no company to infer);
--   * a role held in two or more companies, or by a cross-company account;
--   * a role another company has mapped to one of its approval slots.
DO $$
DECLARE
  system_names TEXT[] := ARRAY[
    'Super Admin', 'Site Admin', 'Project Manager', 'HO User', 'Accountant',
    'Site Engineer', 'Store Keeper', 'Site User', 'General User', 'Viewer'
  ];
  moved INTEGER;
  unheld INTEGER;
  shared INTEGER;
BEGIN
  WITH custom AS (
    SELECT r.id
    FROM "settings"."Role" r
    WHERE NOT r."isProtected"
      AND NOT r."isDefault"
      AND r.name <> ALL (system_names)
  ),
  holder_companies AS (
    SELECT c.id AS role_id,
           COUNT(DISTINCT u."companyId") AS companies,
           COUNT(*) FILTER (WHERE u."companyId" IS NULL) AS cross_company,
           MIN(u."companyId") AS company_id
    FROM custom c
    JOIN "settings"."UserRole" ur ON ur."roleId" = c.id
    JOIN "shared"."User" u ON u.id = ur."userId"
    GROUP BY c.id
  )
  UPDATE "settings"."Role" r
  SET "companyId" = h.company_id
  FROM holder_companies h
  WHERE r.id = h.role_id
    AND h.companies = 1
    AND h.cross_company = 0
    -- Nor a role another company has mapped to one of its approval slots.
    AND NOT EXISTS (
      SELECT 1 FROM "shared"."RoleSlotMapping" m
      WHERE m."roleId" = r.id AND m."companyId" <> h.company_id
    );
  GET DIAGNOSTICS moved = ROW_COUNT;

  SELECT COUNT(*) INTO unheld
  FROM "settings"."Role" r
  WHERE r."companyId" IS NULL
    AND NOT r."isProtected" AND NOT r."isDefault" AND r.name <> ALL (system_names)
    AND NOT EXISTS (SELECT 1 FROM "settings"."UserRole" ur WHERE ur."roleId" = r.id);

  SELECT COUNT(*) INTO shared
  FROM "settings"."Role" r
  WHERE r."companyId" IS NULL
    AND NOT r."isProtected" AND NOT r."isDefault" AND r.name <> ALL (system_names)
    AND EXISTS (SELECT 1 FROM "settings"."UserRole" ur WHERE ur."roleId" = r.id);

  RAISE NOTICE '036 C10 role backfill: % custom role(s) moved to their company; % left global because nobody holds them; % left global because they are held in more than one company, by a cross-company account, or mapped to another company''s approval slot.',
    moved, unheld, shared;
END $$;
