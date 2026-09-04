-- Two things feature 006 needs present on the first boot after deploy: the roles
-- that should hold its new permissions, and the machinery masters an equipment
-- record cannot be created without.

-- ── 0. Claim the super-admin escape hatch for this transaction ──────────────
--
-- The masters seeded in section 2 land in `settings.EquipmentCategory` and
-- `settings.EquipmentDocType`, which 20260904081330 put behind `tenant_isolation`
-- with FORCE ROW LEVEL SECURITY. That policy admits a row only when
-- `app.current_company_id` matches it, or `app.is_super_admin` is 'true'. A
-- migration has neither set, so a cross-company backfill is refused outright:
--   ERROR: new row violates row-level security policy for table "EquipmentCategory"
--
-- This is the first migration in this repo to INSERT into a company-scoped table
-- that FORCEs RLS, which is why no earlier one needed this line. It did not surface
-- in local development because the local database role is a SUPERUSER and so
-- bypasses RLS entirely — the condition `assertRlsEnforceable` warns about on every
-- boot. Production connects as a NOSUPERUSER role, where the policy actually fires.
--
-- The third argument makes this transaction-local (`SET LOCAL` semantics), so it is
-- gone when the migration commits and cannot leak into a later session. It is the
-- same escape hatch the application itself uses for system work that legitimately
-- spans tenants — see `withRlsContext(prisma, { isSuperAdmin: true })`.
SELECT set_config('app.is_super_admin', 'true', true);

-- ── 1. Grant the new permission values to the default roles ─────────────────
--
-- 20260830090000_seed_default_roles wrote each role's permission set wholesale.
-- These UPDATEs are additive instead, because that migration ran long ago and an
-- administrator may have edited these roles since — rewriting the whole array would
-- silently revert their work. `array_append` guarded by `NOT (... = ANY(...))`
-- makes each grant idempotent on its own.
--
-- `INVENTORY_APPROVE` is backfilled here too. Feature 009 added the value and
-- gated indent approval on it but never granted it to anything, so approving an
-- indent has returned 403 for every user since 009 shipped, with no in-product way
-- to discover why. Fixing it here rather than in a 009 patch keeps it to one
-- migration; it is called out because it is not this feature's own value.
--
-- Deliberately not granted to `Site User` or `Viewer`: neither should be opening
-- maintenance jobs, approving rental invoices, or authorising spend.

-- Full administrative reach.
UPDATE "settings"."Role"
SET permissions = permissions || ARRAY['MAINTENANCE','HIRE_BILLS','INVENTORY_APPROVE']::"settings"."Permission"[],
    "updatedAt" = now()
WHERE name IN ('Super Admin', 'Site Admin', 'HO User')
  AND NOT ('MAINTENANCE' = ANY(permissions)
       AND 'HIRE_BILLS' = ANY(permissions)
       AND 'INVENTORY_APPROVE' = ANY(permissions));

-- Runs the yard: opens and closes jobs, but does not authorise the invoice.
UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'MAINTENANCE'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name IN ('Project Manager', 'Site Engineer', 'Store Keeper')
  AND NOT ('MAINTENANCE' = ANY(permissions));

-- A hire bill and a service bill are accounts documents; the storekeeper's parts
-- ledger is not.
UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'HIRE_BILLS'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name = 'Accountant'
  AND NOT ('HIRE_BILLS' = ANY(permissions));

-- The storekeeper owns spare parts stock (US9), which FR-028 gates on MAINTENANCE —
-- so they need it even though they never touch a machine.
UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'INVENTORY_APPROVE'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name = 'Accountant'
  AND NOT ('INVENTORY_APPROVE' = ANY(permissions));

-- ── 2. Seed the machinery masters for every existing company ────────────────
--
-- New companies get these from `CompaniesService.create()`, the same way document
-- types, vendor categories and item categories are seeded. Companies that already
-- exist would otherwise face an empty Category dropdown and be unable to register a
-- single machine, so they are backfilled here. `ON CONFLICT DO NOTHING` against the
-- `(companyId, name)` unique makes a re-run a no-op.
--
-- Ten categories and six document types, chosen to match the master PRD's own
-- examples. `meterType` follows the machine: a crane's life is measured in running
-- hours, a tipper's in kilometres. `fuelBenchmark` is left null rather than guessed —
-- a wrong benchmark would flag variance on every entry from day one, which trains
-- people to ignore the flag.

INSERT INTO "settings"."EquipmentCategory"
  (id, "companyId", name, "meterType", "targetHoursPerMonth", "fuelVarianceThresholdPercent", active, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c.id, m.name, m.meter::"settings"."MeterType", 176, 15, true, now(), now()
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('EXCAVATOR', 'hours'),
  ('LOADER', 'hours'),
  ('CRANE', 'hours'),
  ('TIPPER', 'km'),
  ('TRANSIT MIXER', 'km'),
  ('CONCRETE PUMP', 'hours'),
  ('BATCHING PLANT', 'hours'),
  ('COMPACTOR', 'hours'),
  ('GENERATOR', 'hours'),
  ('DEWATERING PUMP', 'hours')
) AS m(name, meter)
ON CONFLICT ("companyId", name) DO NOTHING;

INSERT INTO "settings"."EquipmentDocType"
  (id, "companyId", name, "alertDays", active, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c.id, d.name, d.days, true, now(), now()
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('REGISTRATION CERTIFICATE', 60),
  ('INSURANCE', 45),
  ('FITNESS CERTIFICATE', 45),
  ('POLLUTION CERTIFICATE', 15),
  ('PERMIT', 30),
  ('OPERATOR LICENCE', 30)
) AS d(name, days)
ON CONFLICT ("companyId", name) DO NOTHING;
