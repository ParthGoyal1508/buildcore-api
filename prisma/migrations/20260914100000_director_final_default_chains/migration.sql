-- 016 FR-018 / FR-018a, T048: the director-final chains every company should have.
--
-- `ChainsService.seedDefaultsForCompany` creates these for any company made from now on.
-- This does the same for the companies that already exist, so whether a payment release
-- is gated does not depend on when the company was created — the kind of difference that
-- is invisible until the one uncovered tenant releases a payment nobody approved.
--
-- Idempotent: every insert is guarded by NOT EXISTS on (companyId, actionType), so a
-- rerun, a company created between this file being written and applied, and the seeder
-- having got there first all land in the same place.
--
-- A single level — the director. These action types are the end of a process, not a
-- process; a company wanting more levels defines them through the settings endpoints.

INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isFinalAuthorityRequired", "isActive", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."id",
  a."actionType",
  true,
  true,
  NOW(),
  NOW()
FROM "settings"."Company" AS c
CROSS JOIN (
  VALUES
    ('payment_release'),
    ('letter_work_order'),
    ('letter_loi'),
    ('letter_purchase_order'),
    ('final_settlement')
) AS a("actionType")
WHERE NOT EXISTS (
  SELECT 1 FROM "shared"."ApprovalChain" AS existing
  WHERE existing."companyId" = c."id" AND existing."actionType" = a."actionType"
);

-- The one level of each chain just created. Matched by (companyId, actionType) rather
-- than by a returned id, because the INSERT above is set-based and a rerun must be able
-- to repair a chain whose level insert failed halfway.
INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "isFinalAuthority", "label", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  ch."id",
  ch."companyId",
  1,
  'final',
  true,
  'Director',
  NOW(),
  NOW()
FROM "shared"."ApprovalChain" AS ch
WHERE ch."actionType" IN (
    'payment_release', 'letter_work_order', 'letter_loi',
    'letter_purchase_order', 'final_settlement'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" AS l WHERE l."chainId" = ch."id"
  );
