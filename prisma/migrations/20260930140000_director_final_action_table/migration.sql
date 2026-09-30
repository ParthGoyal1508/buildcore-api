-- 016 Phase 9, 2026-09-30. The director-final set becomes data.
--
-- It was `APPROVALS_DIRECTOR_FINAL_ACTIONS`, an env var read once at construction. That met
-- FR-018a's "configurable without a code change" only weakly: a redeploy, global across both
-- of the client's companies, and unauditable — so FR-018b's "the set before and after" had
-- nowhere to be recorded and FR-018c had nothing to report from.
--
-- The config list stays, as the seed below and as the runtime fallback for an action type no
-- company has configured. This migration must therefore be **inert**: the seeded rows
-- reproduce exactly what the env var already said, so no approval gate appears or disappears.
-- That is what T090's before/after comparison checks, and a green deploy is not the gate.

-- ── RLS context for the data statements below ────────────────────────────────
--
-- `shared.DirectorFinalAction` is tenant-scoped and FORCEs RLS. Production connects as
-- `buildcore_app` (NOSUPERUSER, NOBYPASSRLS) where the policy fires; local development
-- connects as a SUPERUSER and bypasses RLS entirely, which is why this class of defect
-- cannot be caught by running migrations locally.
--
-- The consequence of omitting this line here is the worst in the repository: the seed would
-- match zero rows, the deploy would go green, and **every director approval gate would
-- silently stop existing** — payment release, payroll runs, money-committing letters and
-- final settlement all taking effect with nobody's signature. Five migrations failed in
-- exactly this way in production on 2026-09-16, for exactly this reason.
SELECT set_config('app.is_super_admin', 'true', true);

CREATE TABLE "shared"."DirectorFinalAction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "isFinal" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DirectorFinalAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DirectorFinalAction_companyId_actionType_key"
  ON "shared"."DirectorFinalAction"("companyId", "actionType");

CREATE INDEX "DirectorFinalAction_companyId_idx"
  ON "shared"."DirectorFinalAction"("companyId");

ALTER TABLE "shared"."DirectorFinalAction"
  ADD CONSTRAINT "DirectorFinalAction_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- WITH CHECK written explicitly rather than left to default from USING. Postgres reuses
-- USING as the WITH CHECK expression when it is omitted, which works but means a later edit
-- to one silently changes the other.
ALTER TABLE "shared"."DirectorFinalAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."DirectorFinalAction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."DirectorFinalAction"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- ── The seed: exactly what the env var already said ──────────────────────────
--
-- The six action types the four the client named decompose into, plus
-- `director_final_set_change` — the gate on changing the gates.
--
-- `director_final_set_change` is seeded here and is deliberately **never offered as
-- configurable** (FR-018b, plan D24). If the gate on removing gates could itself be removed,
-- that is the first thing anybody bypassing the chain would remove.
--
-- Idempotent on (companyId, actionType), so re-running is safe and a company seeded before
-- this migration existed still gets its rows.
INSERT INTO "shared"."DirectorFinalAction" ("id", "companyId", "actionType", "isFinal", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."id",
  a."actionType",
  true,
  CURRENT_TIMESTAMP
FROM "settings"."Company" c
CROSS JOIN (VALUES
  ('payment_release'),
  ('payroll_run'),
  ('letter_work_order'),
  ('letter_loi'),
  ('letter_purchase_order'),
  ('final_settlement'),
  ('director_final_set_change')
) AS a("actionType")
ON CONFLICT ("companyId", "actionType") DO NOTHING;

-- ── The proposal row ────────────────────────────────────────────────────────
--
-- A change's before and after have to live somewhere: `ApprovalInstance` carries no payload
-- by design. Same shape of problem `hr.PendingAttendanceCorrection` solves for attendance
-- corrections, and here the owning module is the spine itself — it is allowed to know about
-- its own settings.
CREATE TABLE "shared"."DirectorFinalChangeProposal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "approvalInstanceId" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectorFinalChangeProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DirectorFinalChangeProposal_approvalInstanceId_key"
  ON "shared"."DirectorFinalChangeProposal"("approvalInstanceId");

CREATE INDEX "DirectorFinalChangeProposal_companyId_appliedAt_idx"
  ON "shared"."DirectorFinalChangeProposal"("companyId", "appliedAt");

ALTER TABLE "shared"."DirectorFinalChangeProposal"
  ADD CONSTRAINT "DirectorFinalChangeProposal_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shared"."DirectorFinalChangeProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."DirectorFinalChangeProposal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."DirectorFinalChangeProposal"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
