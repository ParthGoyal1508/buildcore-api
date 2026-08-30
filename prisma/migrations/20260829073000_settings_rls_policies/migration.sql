-- Row-level security for every companyId-scoped table this feature adds, reusing
-- verbatim the session-variable pattern feature 001 established in
-- 20260828162304_multi_schema_and_auth_extensions / 20260828170000_role_permission_model
-- and that src/common/prisma/rls-context.ts sets (research.md §8, Principle IV).
--
-- `Company` itself is intentionally absent: it is the tenant root and carries no
-- companyId of its own, so it is gated by the COMPANY_SETTINGS permission at the
-- guard layer instead of by RLS (research.md §8, FR-001).
--
-- Policy-only migration — Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL rather than generated DDL, exactly as 001's own
-- RLS migration was.

ALTER TABLE "settings"."Department" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."Department" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."Department"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."Designation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."Designation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."Designation"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."DocumentType" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."DocumentType" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."DocumentType"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."Shift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."Shift" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."Shift"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."EmployeeCodeSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."EmployeeCodeSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."EmployeeCodeSequence"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- FR-004's collision rule is case-insensitive and trimmed. CompaniesService
-- normalizes to trimmed uppercase on write; this functional index is the
-- database-level backstop, so two concurrent creates can't both pass an
-- application-layer check and land (the same race Principle IV's RLS rationale
-- calls out). Prisma cannot express a functional index, hence raw SQL here.
CREATE UNIQUE INDEX "Company_shortCode_lower_key"
  ON "settings"."Company" (lower("shortCode"));
