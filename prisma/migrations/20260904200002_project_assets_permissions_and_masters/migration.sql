-- Two things feature 012 needs present on the first boot after deploy: the roles that
-- should hold its new permissions, and the masters an asset cannot be registered —
-- or returned — without.
--
-- Separate from 20260904200000 because that migration is what *adds* the `ASSETS`,
-- `ASSETS_APPROVE` and `AssetTrackingMode` enum values, and Postgres refuses to use a
-- new enum value inside the transaction that added it. 006 split its own migration
-- the same way, for the same reason.

-- ── 0. Claim the super-admin escape hatch for this transaction ──────────────
--
-- The masters seeded in section 2 land in `settings.AssetCategory`,
-- `settings.AssetDocType` and `settings.ConditionGrade`, which 20260904200001 put
-- behind `tenant_isolation` with FORCE ROW LEVEL SECURITY. That policy admits a row
-- only when `app.current_company_id` matches it, or `app.is_super_admin` is 'true'. A
-- migration has neither set, so a cross-company backfill is refused outright:
--   ERROR: new row violates row-level security policy for table "AssetCategory"
--
-- This is not hypothetical: 006's masters backfill shipped without this line, passed
-- every local run because the development database role is a SUPERUSER and bypasses
-- RLS entirely, and then failed the production deploy with exactly that error —
-- P3009, a failed migration blocking every subsequent one. The condition
-- `assertRlsEnforceable` warns about on every local boot is the same one.
--
-- The third argument makes this transaction-local (`SET LOCAL` semantics), so it is
-- gone when the migration commits and cannot leak into a later session. It is the
-- same escape hatch the application itself uses for system work that legitimately
-- spans tenants — see `withRlsContext(prisma, { isSuperAdmin: true })`.
SELECT set_config('app.is_super_admin', 'true', true);

-- ── 1. Grant the new permission values to the default roles ─────────────────
--
-- Additive rather than a wholesale rewrite, for the reason 006's grant documents:
-- 20260830090000_seed_default_roles ran long ago and an administrator may have edited
-- these roles since. `array_append` guarded by a `NOT (... = ANY(...))` test makes
-- each grant idempotent on its own.
--
-- `INVENTORY` is deliberately not reused (spec FR-033). A storekeeper who issues
-- cement is not thereby accountable for who is holding the total station, and the two
-- registers answer to different people.

-- Full administrative reach: register, allocate, transfer — and authorise.
UPDATE "settings"."Role"
SET permissions = permissions || ARRAY['ASSETS','ASSETS_APPROVE']::"settings"."Permission"[],
    "updatedAt" = now()
WHERE name IN ('Super Admin', 'Site Admin', 'HO User')
  AND NOT ('ASSETS' = ANY(permissions) AND 'ASSETS_APPROVE' = ANY(permissions));

-- Runs the register day to day: registers assets, allocates them, raises and receives
-- transfers, records inspections. Does not authorise a request, condemn an asset, or
-- cancel a transfer in flight — those are the three decisions that write value off or
-- override someone else's, which is what `ASSETS_APPROVE` separates.
UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'ASSETS'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name IN ('Project Manager', 'Site Engineer', 'Store Keeper')
  AND NOT ('ASSETS' = ANY(permissions));

-- Deliberately not granted to `Accountant`, `Site User` or `Viewer`. Unlike 006's
-- hire bills, nothing in this module is an accounts document: depreciation here is a
-- costing figure and never a posting (spec FR-020), so the accountant has nothing to
-- do on these screens. Site User and Viewer are read-only roles by design.

-- ── 2. Seed the masters for every existing company ──────────────────────────
--
-- New companies get these from `CompaniesService.create()`, the same way document
-- types, vendor categories, item categories and equipment masters are seeded.
-- Companies that already exist would otherwise face three empty dropdowns and be
-- unable to register a single asset, so they are backfilled here. `ON CONFLICT DO
-- NOTHING` against the `(companyId, name)` unique makes a re-run a no-op.
--
-- Condition grades matter more than the other two: a return maps its grade to the
-- asset's next status through `isDamaged` / `isScrap` (spec FR-015), so an empty
-- grade list does not merely inconvenience the register — it makes returning an asset
-- impossible.

-- The seven categories the spec's scope note names, with their tracking modes.
-- `depreciationRatePercent` and `usefulLifeYears` follow the class of item: a laptop
-- is written down over three years and a scaffolding pipe over seven. Custody is
-- required only where an individual can reasonably be held accountable for one unit —
-- nobody signs for a pipe. Inspection intervals are set only where a periodic check
-- is a real practice (tools and safety gear), not everywhere, because a due date
-- nobody intends to honour trains people to ignore the reminder.
INSERT INTO "settings"."AssetCategory"
  (id, "companyId", name, "trackingMode", "depreciationRatePercent", "usefulLifeYears",
   "custodyRequired", "inspectionRequired", "inspectionIntervalDays",
   "repairCostThresholdPercent", active, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c.id, m.name, m.mode::"settings"."AssetTrackingMode",
       m.rate, m.life, m.custody, m.inspect, m.interval, 50, true, now(), now()
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('SCAFFOLDING',      'bulk',       15.00,  7, false, false, NULL::int),
  ('SHUTTERING',       'bulk',       20.00,  5, false, false, NULL::int),
  ('FORMWORK',         'bulk',       20.00,  5, false, false, NULL::int),
  ('POWER TOOLS',      'serialised', 25.00,  4, true,  true,  180),
  ('SAFETY EQUIPMENT', 'bulk',       33.00,  3, false, true,  90),
  ('IT ASSETS',        'serialised', 33.00,  3, true,  false, NULL::int),
  ('SITE FURNITURE',   'bulk',       15.00,  7, false, false, NULL::int)
) AS m(name, mode, rate, life, custody, inspect, interval)
ON CONFLICT ("companyId", name) DO NOTHING;

-- Document types, each with its own renewal notice (spec FR-025). A calibration
-- certificate is booked a fortnight out; an insurance renewal takes longer.
INSERT INTO "settings"."AssetDocType"
  (id, "companyId", name, "alertDays", active, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c.id, d.name, d.days, true, now(), now()
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('INSURANCE',               45),
  ('WARRANTY',                30),
  ('CALIBRATION CERTIFICATE', 30),
  ('TEST CERTIFICATE',        30),
  ('AMC CONTRACT',            45),
  ('PURCHASE INVOICE',        30)
) AS d(name, days)
ON CONFLICT ("companyId", name) DO NOTHING;

-- The condition ladder, best first. `sequence` ascending is *worsening* condition,
-- which is what lets a transfer receipt detect that an asset arrived in a worse state
-- than it was dispatched in (US5 scenario 5) by comparing two integers.
--
-- Only the bottom two rungs carry behaviour: DAMAGED sends a returned asset to
-- `under_repair` and SCRAP to `scrapped` (spec FR-015). POOR deliberately does not —
-- a worn but working item is still usable, and forcing it into the repair queue would
-- make the queue meaningless.
INSERT INTO "settings"."ConditionGrade"
  (id, "companyId", name, sequence, "isDamaged", "isScrap", active, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c.id, g.name, g.seq, g.damaged, g.scrap, true, now(), now()
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('NEW',     1, false, false),
  ('GOOD',    2, false, false),
  ('FAIR',    3, false, false),
  ('POOR',    4, false, false),
  ('DAMAGED', 5, true,  false),
  ('SCRAP',   6, false, true)
) AS g(name, seq, damaged, scrap)
ON CONFLICT ("companyId", name) DO NOTHING;
