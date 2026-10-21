-- 2026-10-20. Leave, reimbursement claims, employee loans, salary advances and labour advances
-- move onto the approval spine, so their approvers are configured in Settings → Approvals like
-- every other chain ("Everything which has approval should be there in the settings"). This
-- reverses 016 FR-022 for these five; the rest of that list follows in later waves.

-- Production connects as `buildcore_app` (NOBYPASSRLS); without this the chain INSERTs below are
-- refused or match nothing. See 20260930120000_attendance_correction_chain.
SELECT set_config('app.is_super_admin', 'true', true);

-- ── Who may not decide an item ───────────────────────────────────────────────
--
-- The spine authorised by role alone, and each module kept its own maker-checker in front of its
-- own approve endpoint. With the decision now also reachable from the Approvals page, that guard
-- has to live where the decision is taken: the applicant, the maker, and the employee being paid
-- are stamped here at submit and refused by `ApprovalService.decide`. Empty for every existing
-- item, so no current chain changes behaviour.
ALTER TABLE "shared"."ApprovalInstance"
  ADD COLUMN "excludedUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── A rejected state for the three money flows that had none ─────────────────
--
-- A loan or advance could only be approved or left pending; a chain can now reject one.
ALTER TYPE "payroll"."LoanStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE "hr"."SalaryAdvanceStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE "labour"."AdvanceStatus" ADD VALUE IF NOT EXISTS 'rejected';

-- ── The chains, for every company that already exists ────────────────────────
--
-- One Head Office level each — the single step these flows already had. Idempotent on
-- (companyId, actionType); new companies get them from `DEFAULT_COMPANY_CHAINS`.
INSERT INTO "shared"."ApprovalChain" ("id", "companyId", "actionType", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", a."actionType", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('leave_application'),
  ('reimbursement_claim'),
  ('employee_loan'),
  ('salary_advance'),
  ('labour_advance')
) AS a("actionType")
WHERE NOT EXISTS (
  SELECT 1 FROM "shared"."ApprovalChain" ac
  WHERE ac."companyId" = c."id" AND ac."actionType" = a."actionType"
);

INSERT INTO "shared"."ApprovalLevel" ("id", "chainId", "companyId", "position", "slotKey", "label", "isFinalAuthority", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, ac."id", ac."companyId", 1, 'hr', 'Head Office', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "shared"."ApprovalChain" ac
WHERE ac."actionType" IN ('leave_application', 'reimbursement_claim', 'employee_loan', 'salary_advance', 'labour_advance')
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" al WHERE al."chainId" = ac."id"
  );
