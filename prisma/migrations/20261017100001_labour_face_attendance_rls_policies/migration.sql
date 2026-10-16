-- Row-level security for 031's five new labour tables, the same tenant_isolation policy every
-- labour table carries (20260904120001_labour_rls_policies).

ALTER TABLE "labour"."SiteWageRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."SiteWageRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."SiteWageRate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."SupervisorSite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."SupervisorSite" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."SupervisorSite"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourCodeSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourCodeSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourCodeSequence"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourPunch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourPunch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourPunch"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "labour"."LabourPunchRefusal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourPunchRefusal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourPunchRefusal"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
