-- Row-level security for feature 012's eleven tables (Constitution Principle IV,
-- spec FR-001), reusing verbatim the session-variable pattern established in
-- 20260829073000_settings_rls_policies and extended by every feature since, set by
-- src/common/prisma/rls-context.ts.
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception every feature since 001 takes.
--
-- Every one of these is the standard equality test: each row belongs to exactly one
-- company. The three `settings` masters are scoped the same way `EquipmentCategory`,
-- `ItemCategory` and `SkillCategory` already are.
--
-- FORCE, not merely ENABLE: without it the table owner bypasses its own policy, which
-- is the difference between a policy that is written and one that is in effect.

-- ── settings masters (spec FR-002) ────────────────────────────────────────────
ALTER TABLE "settings"."AssetCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."AssetCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."AssetCategory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."AssetDocType" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."AssetDocType" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."AssetDocType"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."ConditionGrade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."ConditionGrade" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."ConditionGrade"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── assets operational tables ─────────────────────────────────────────────────
ALTER TABLE "assets"."Asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."Asset" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."Asset"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetStock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetStock" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetStock"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetAllocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetAllocation"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetTransfer"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetRequest"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetInspection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetInspection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetInspection"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetRepair" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetRepair" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetRepair"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "assets"."AssetDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets"."AssetDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "assets"."AssetDocument"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

