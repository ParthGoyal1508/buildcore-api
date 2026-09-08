-- Grants feature 013's `LABOUR_APPROVE` to the roles that need it.
--
-- 20260904120000 added `LABOUR_APPROVE` to the `Permission` enum but gave it to
-- nobody, so the whole authorising half of the labour module shipped unreachable.
-- Seven endpoints are gated on it — approve and return a muster, approve and reopen a
-- payment sheet, reverse a disbursed line, approve and disburse a labour advance — and
-- with no role holding the value every one of them answered 403 to every caller,
-- Super Admin included. A supervisor could capture a muster and then nobody in the
-- system could approve it, which strands the payment sheet that reads from it.
--
-- Exactly the failure 20260905120000 fixed for `RECRUITMENT`/`RECRUITMENT_APPROVE`,
-- and the same shape of fix.
--
-- A separate migration rather than an edit to 20260904120000: that migration is what
-- *adds* the enum value, and Postgres refuses to use a new enum value inside the
-- transaction that added it. 006, 011 and 012 all split theirs the same way.
--
-- No `app.is_super_admin` escape hatch: `settings."Role"` carries no row-level
-- security at all — roles are global rather than company-scoped — so an UPDATE from a
-- migration reaches every row. Checked rather than assumed, for the reason 006's
-- silently-zero-row backfill exists.
--
-- Idempotent: the `NOT (... = ANY(permissions))` guard makes a re-run, or a run
-- against a database where an administrator has already granted this by hand, a no-op
-- rather than a duplicate array entry.
--
-- Role mapping. FR-038 defines what the value means but names no roles. It goes to
-- exactly the three roles that already hold `DAILY_WORKER_REGISTRY` — Super Admin,
-- Site Admin and HO User — because approving a muster you cannot see is not a
-- capability, and those three are the only seeded roles who can see one.
--
-- Deliberately NOT granted to Project Manager, Site Engineer, Store Keeper,
-- Accountant, Site User or Viewer: none of them hold `DAILY_WORKER_REGISTRY` either,
-- so the grant would be inert today and misleading tomorrow. The QA fixture roles are
-- left alone, as 011 and 012 left them.
--
-- The split is what makes a capture-only supervisor role possible: an administrator
-- creates a role with `DAILY_WORKER_REGISTRY` and without `LABOUR_APPROVE`, and that
-- supervisor can record attendance but not authorise their own muster. That
-- separation is the reason 013 added a second permission at all (FR-038), and it is
-- undone by granting this value to every labour role by default.

UPDATE "settings"."Role"
SET permissions = array_append(permissions, 'LABOUR_APPROVE'::"settings"."Permission"),
    "updatedAt" = now()
WHERE name IN ('Super Admin', 'Site Admin', 'HO User')
  AND NOT ('LABOUR_APPROVE' = ANY(permissions));
