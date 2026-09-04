-- Row-level security for feature 013's ten tables (Constitution Principle IV),
-- reusing verbatim the session-variable pattern established in
-- 20260829073000_settings_rls_policies and extended by every feature since, set by
-- src/common/prisma/rls-context.ts.
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception every feature since 001 takes.
--
-- Every one of these is the standard equality test: each row belongs to exactly one
-- company. The `settings.SkillCategory` master is scoped the same way `VendorCategory`
-- and `Item` already are.

-- ── settings master (research.md §1) ────────────────────────────────────────

ALTER TABLE "settings"."SkillCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."SkillCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."SkillCategory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── labour operational tables ───────────────────────────────────────────────

ALTER TABLE "labour"."WageRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."WageRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."WageRate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourWorker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourWorker" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourWorker"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourGang" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourGang" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourGang"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."GangMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."GangMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."GangMember"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."MusterRoll" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."MusterRoll" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."MusterRoll"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."MusterLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."MusterLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."MusterLine"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourPaymentSheet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourPaymentSheet" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourPaymentSheet"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."PaymentSheetLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."PaymentSheetLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."PaymentSheetLine"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourAdvance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourAdvance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourAdvance"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
