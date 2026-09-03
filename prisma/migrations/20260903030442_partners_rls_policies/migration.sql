-- Row-level security for the ten tables feature 007 adds, reusing verbatim the
-- session-variable pattern established in 20260829073000_settings_rls_policies and
-- extended by 003 and 005, set by src/common/prisma/rls-context.ts (Principle IV).
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception features 001-005 already take.
--
-- Scoping follows 005's rule: a table owning a companyId is scoped on it directly; a
-- table that belongs to a parent row is scoped THROUGH that parent rather than
-- carrying a copied tenant key, because a duplicated companyId is a second source of
-- truth that every future move-between-companies operation has to remember to rewrite.

-- ── Company-level tables: direct companyId ──────────────────────────────────

ALTER TABLE "settings"."VendorCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."VendorCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."VendorCategory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."CodeSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."CodeSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."CodeSequence"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "partners"."Vendor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."Vendor" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."Vendor"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "partners"."ContractorProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."ContractorProfile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."ContractorProfile"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- MonthlyCompliance keeps its own companyId as well as its parent link. Unlike the
-- child tables below it is queried company-wide and month-ranged by the RAG matrix
-- and by the compliance cron, both of which scan across contractors rather than
-- starting from one. Scoping through the parent would turn that scan into a
-- correlated subquery per row for no integrity gain, since a compliance record can
-- never outlive the contractor it cascades from.
ALTER TABLE "partners"."MonthlyCompliance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."MonthlyCompliance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."MonthlyCompliance"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "partners"."BOCWPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."BOCWPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."BOCWPayment"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── Vendor-owned tables: scoped through the owning Vendor ───────────────────
-- Each is indexed on vendorId and partners.Vendor is indexed on companyId, so the
-- EXISTS stays an index lookup. The subquery reads the Vendor row, itself
-- RLS-protected, so it cannot be satisfied by a vendor the caller may not see.

ALTER TABLE "partners"."VendorContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."VendorContact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."VendorContact"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "partners"."Vendor" v
      WHERE v."id" = "VendorContact"."vendorId"
        AND v."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "partners"."VendorDealsIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."VendorDealsIn" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."VendorDealsIn"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "partners"."Vendor" v
      WHERE v."id" = "VendorDealsIn"."vendorId"
        AND v."companyId" = current_setting('app.current_company_id', true)
    )
  );

ALTER TABLE "partners"."VendorHireDetail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."VendorHireDetail" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."VendorHireDetail"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "partners"."Vendor" v
      WHERE v."id" = "VendorHireDetail"."vendorId"
        AND v."companyId" = current_setting('app.current_company_id', true)
    )
  );

-- ── Contractor-owned tables: scoped through ContractorProfile ───────────────
-- A contractor document carries no companyId of its own. It is reached only through
-- the profile, which is already tenant-scoped above, and copying the key onto every
-- document row would create exactly the drift this pattern exists to avoid.

ALTER TABLE "partners"."ContractorDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"."ContractorDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "partners"."ContractorDocument"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "partners"."ContractorProfile" cp
      WHERE cp."id" = "ContractorDocument"."contractorProfileId"
        AND cp."companyId" = current_setting('app.current_company_id', true)
    )
  );
