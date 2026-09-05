-- Grants feature 011's two permissions to the roles that need them.
--
-- 20260904130000 added `RECRUITMENT` and `RECRUITMENT_APPROVE` to the `Permission`
-- enum but gave them to nobody, so the module shipped unreachable: feature 014 draws
-- the sidebar by filtering `NAV_MODULES` against the caller's permissions, and every
-- `/recruitment/*` endpoint is gated by `@RequirePermission()` (spec FR-030). With no
-- role holding either value, not even Super Admin could see the module or call it —
-- the API answered 403 and the nav entry silently never rendered.
--
-- A separate migration rather than an edit to 20260904130000: that migration is what
-- *adds* the enum values, and Postgres refuses to use a new enum value inside the
-- transaction that added it. 006 and 012 split theirs the same way, for the same
-- reason.
--
-- No `app.is_super_admin` escape hatch here, unlike 012's masters backfill:
-- `settings."Role"` carries no row-level security at all (roles are global rather than
-- company-scoped), so an UPDATE from a migration reaches every row. The check was made
-- rather than assumed — 006 shipped a backfill that silently matched zero rows in
-- production for exactly this reason.
--
-- Every statement is idempotent: the `NOT (... = ANY(permissions))` guard means
-- re-running this migration, or running it against a database where an administrator
-- has already granted the permission by hand, is a no-op rather than a duplicate.
--
-- Role mapping. Spec FR-031 defines what the two values mean but names no roles, so
-- the assignment below follows the split 012 used for `ASSETS`/`ASSETS_APPROVE`:
--
--   RECRUITMENT          manage requisitions, candidates, interviews, offers,
--                        onboarding and letters — the people who run hiring.
--   RECRUITMENT_APPROVE  approve a requisition, issue an offer above its budgeted
--                        maximum, waive an onboarding item, accept a resignation —
--                        authorising, which is not the same as doing.
--
-- Project Manager gets the first and not the second on purpose: a manager raises the
-- requisition for their own project and sits on the interview panel, and letting them
-- approve their own requisition or waive their own hire's onboarding items would make
-- the approval step ceremonial. Site Engineer, Store Keeper, Accountant, Site User and
-- Viewer get neither — none of them hire. The QA fixture roles are left alone, as 012
-- left them.

-- ── Full access: run the funnel and authorise it ────────────────────────────
UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'RECRUITMENT'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name IN ('Super Admin', 'Site Admin', 'HO User')
  AND NOT ('RECRUITMENT' = ANY(permissions));

UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'RECRUITMENT_APPROVE'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name IN ('Super Admin', 'Site Admin', 'HO User')
  AND NOT ('RECRUITMENT_APPROVE' = ANY(permissions));

-- ── Operate the funnel, but do not authorise it ─────────────────────────────
UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'RECRUITMENT'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name IN ('Project Manager')
  AND NOT ('RECRUITMENT' = ANY(permissions));
