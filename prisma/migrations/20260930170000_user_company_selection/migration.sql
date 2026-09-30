-- 019 Phase 4, 2026-09-30. Which company a user is working in (FR-008 to FR-013).
--
-- Stored server-side because FR-011 requires the selection to survive a browser restart and
-- access tokens here are short-lived. A cookie would make it a client assertion about
-- authorisation scope, which is the one thing it must not be.
--
-- Additive, no backfill, no data statement — so no `set_config` guard is needed, and saying so
-- is deliberate: that line belongs where a data statement exists and nowhere else, or it
-- becomes a ritual rather than a decision.

CREATE TABLE "settings"."UserCompanySelection" (
    -- The user IS the key, so two selections for one user are unrepresentable rather than
    -- merely prevented.
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCompanySelection_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "UserCompanySelection_companyId_idx"
  ON "settings"."UserCompanySelection"("companyId");

ALTER TABLE "settings"."UserCompanySelection"
  ADD CONSTRAINT "UserCompanySelection_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation on the *selected* company, with WITH CHECK written explicitly.
--
-- Note what this policy does and does not do. It stops one company's context reading another
-- company's selections. It does **not** make the selection authorisation: the row says which
-- company a user chose, and whether they may choose it is checked in the service on every
-- read. A policy cannot answer that question, because the question is about the user's
-- accessible companies rather than about the row's tenant.
ALTER TABLE "settings"."UserCompanySelection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."UserCompanySelection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."UserCompanySelection"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
