-- 018 Phase 4, 2026-10-03. Certifying a subcontractor's RA bill, and FR-009: editing a certified
-- bill's quantities sends it round again.
--
-- Two things: the columns that record who revised a bill and how often, and the approval chain the
-- bill enters, seeded for every company that already exists.
--
-- Why no payload table, unlike the attendance correction: an RA bill *is* its own record. The spine
-- points at `projects.RABill` by id and the bill's own `status` carries where it is, so there is
-- nothing to park elsewhere while a decision is pending.

-- ── RLS context for the data statements below ────────────────────────────────
--
-- The chain seed writes one ApprovalChain and one ApprovalLevel row per existing company.
-- Production connects as `buildcore_app` (NOSUPERUSER, NOBYPASSRLS) where
-- `shared.ApprovalChain`'s tenant_isolation policy fires; local development connects as a
-- SUPERUSER and bypasses RLS entirely, which is why this class of defect cannot be caught by
-- running migrations locally. Five migrations failed this way in production on 2026-09-16.
SELECT set_config('app.is_super_admin', 'true', true);

-- FR-016: the actor and time for every bill *edited*, which nothing recorded until now. The count
-- is kept because the number of times a certified bill went round again is the thing a reader wants
-- and the thing an audit trail makes them reconstruct by hand.
ALTER TABLE "projects"."RABill"
  ADD COLUMN "revisionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastRevisedAt" TIMESTAMP(3),
  ADD COLUMN "lastRevisedByUserId" TEXT;

-- ── The chain, for every company that already exists ────────────────────────
--
-- `seedDefaultsForCompany` covers companies created from now on. This covers the ones already
-- here, and is idempotent on (companyId, actionType) so re-running it is safe.
--
-- **One level, the Director.** The minimum gate that makes FR-009 mean something, and deliberately
-- not a claim that the client asked for a Director signature on every RA bill — see
-- `ACTION_RA_BILL` in default-chains.ts. A company wanting Site Incharge → Projects → Director
-- defines it through the existing settings endpoints; the slot key is what each company maps to its
-- own roles, so nothing here assumes an org chart.
INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", 'ra_bill', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "settings"."Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "shared"."ApprovalChain" ac
  WHERE ac."companyId" = c."id" AND ac."actionType" = 'ra_bill'
);

INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "label", "isFinalAuthority", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  ac."id",
  ac."companyId",
  1,
  'final',
  'Director',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "shared"."ApprovalChain" ac
WHERE ac."actionType" = 'ra_bill'
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" al
    WHERE al."chainId" = ac."id" AND al."position" = 1
  );
