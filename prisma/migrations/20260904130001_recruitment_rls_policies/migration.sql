-- Row-level security for feature 011's thirteen tables (Constitution Principle IV),
-- reusing verbatim the session-variable pattern established in
-- 20260829073000_settings_rls_policies and extended by every feature since, set by
-- src/common/prisma/rls-context.ts.
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- hand-authored SQL — the exception every feature since 001 takes.

-- ── settings masters (research.md §1) ───────────────────────────────────────

ALTER TABLE "settings"."KitItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."KitItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."KitItem"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."LetterTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."LetterTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."LetterTemplate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── recruitment operational tables ──────────────────────────────────────────

ALTER TABLE "recruitment"."Requisition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."Requisition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."Requisition"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."Candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."Candidate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."Candidate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."CandidateStageHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."CandidateStageHistory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."CandidateStageHistory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."Interview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."Interview" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."Interview"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."InterviewInterviewer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."InterviewInterviewer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."InterviewInterviewer"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."InterviewFeedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."InterviewFeedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."InterviewFeedback"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."Offer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."Offer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."Offer"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."OnboardingChecklist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."OnboardingChecklist" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."OnboardingChecklist"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."OnboardingItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."OnboardingItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."OnboardingItem"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."GeneratedLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."GeneratedLetter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."GeneratedLetter"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "recruitment"."Resignation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment"."Resignation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recruitment"."Resignation"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
