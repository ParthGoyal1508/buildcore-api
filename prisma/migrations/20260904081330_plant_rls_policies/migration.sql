-- Row-level security for feature 006's thirteen tables (Constitution Principle IV),
-- reusing verbatim the session-variable pattern established in
-- 20260829073000_settings_rls_policies and extended by every feature since, set by
-- src/common/prisma/rls-context.ts.
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception every feature since 001 takes.
--
-- Every one of these is the standard equality test. `EquipmentDocument` and
-- `SparePartMovement` carry their own `companyId` rather than inheriting scope
-- through their parent row, for the reason 009's `PaymentAllocation` does: a policy
-- that had to join to another table to decide would be evaluated per row on every
-- read, and a denormalised column the writer always sets is both cheaper and
-- impossible to get wrong at read time.

ALTER TABLE "settings"."EquipmentCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."EquipmentCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."EquipmentCategory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."EquipmentDocType" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."EquipmentDocType" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."EquipmentDocType"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."HireRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."HireRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."HireRate"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."Equipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."Equipment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."Equipment"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."EquipmentDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."EquipmentDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."EquipmentDocument"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."LogbookEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."LogbookEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."LogbookEntry"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."FuelEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."FuelEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."FuelEntry"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."ServiceSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."ServiceSchedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."ServiceSchedule"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."MaintenanceJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."MaintenanceJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."MaintenanceJob"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."HireBill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."HireBill" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."HireBill"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."SparePart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."SparePart" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."SparePart"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."SparePartMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."SparePartMovement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."SparePartMovement"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "plant"."ServiceBill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."ServiceBill" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."ServiceBill"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
