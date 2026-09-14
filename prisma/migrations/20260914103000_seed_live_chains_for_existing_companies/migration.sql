-- 016 FR-012, FR-015, FR-018: the attendance-exception and payroll-run chains, for
-- companies that already existed when this feature shipped.
--
-- `seedDefaultsForCompany` has created these on company *creation* since Phase 1, so every
-- company made since then has them. Companies made before then have none, and that
-- asymmetry stopped being cosmetic in Phase 5: `payroll_run` is one of FR-018's named
-- action types, so the take-effect gate now refuses a run with no approval instance rather
-- than waving it through. Without a chain there is nothing to submit into, so without this
-- migration no pre-existing company could produce a bank transfer sheet at all.
--
-- **The chains alone are not enough.** A level resolves to a role through
-- `RoleSlotMapping`, and this migration deliberately creates no mappings: which of a
-- company's roles is its "HR" is a decision only that company can make, and guessing would
-- hand the right to approve payroll to whichever role a heuristic happened to pick. Until
-- an administrator maps the slots through the settings screen, items enter these chains
-- and wait — visibly, with `slot_unmapped` as the stated reason, which is the whole point
-- of that value existing.
--
-- Idempotent throughout: guarded by NOT EXISTS on (companyId, actionType).

INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isFinalAuthorityRequired", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", a."actionType", true, true, NOW(), NOW()
FROM "settings"."Company" AS c
CROSS JOIN (VALUES ('attendance_exception'), ('payroll_run')) AS a("actionType")
WHERE NOT EXISTS (
  SELECT 1 FROM "shared"."ApprovalChain" AS existing
  WHERE existing."companyId" = c."id" AND existing."actionType" = a."actionType"
);

-- Employer → HR → Director (Note 2) and Site Incharge → HR Office → Director (Note 7).
-- One three-tier shape, two sets of words, matching `default-chains.ts` exactly — the
-- labels differ because the words the client used differ.
INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "isFinalAuthority", "label", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, ch."id", ch."companyId", v."position", v."slotKey", v."isFinal", v."label", NOW(), NOW()
FROM "shared"."ApprovalChain" AS ch
JOIN LATERAL (
  SELECT * FROM (VALUES
    ('attendance_exception', 1, 'first_approver', false, 'Site / Employer'),
    ('attendance_exception', 2, 'hr',            false, 'HR'),
    ('attendance_exception', 3, 'final',         true,  'Director'),
    ('payroll_run',          1, 'first_approver', false, 'Site Incharge'),
    ('payroll_run',          2, 'hr',             false, 'HR Office'),
    ('payroll_run',          3, 'final',          true,  'Director')
  ) AS t("actionType", "position", "slotKey", "isFinal", "label")
  WHERE t."actionType" = ch."actionType"
) AS v ON true
WHERE ch."actionType" IN ('attendance_exception', 'payroll_run')
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" AS l WHERE l."chainId" = ch."id"
  );
