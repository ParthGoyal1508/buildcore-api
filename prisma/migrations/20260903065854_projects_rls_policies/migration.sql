-- Row-level security for the eleven tables feature 008 adds, reusing verbatim the
-- session-variable pattern established in 20260829073000_settings_rls_policies and
-- extended by 003, 005 and 007, set by src/common/prisma/rls-context.ts
-- (Constitution Principle IV).
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception every feature since 001 takes.
--
-- Scoping follows 005/007's rule: a table owning a companyId is scoped on it
-- directly; a table that belongs to a parent row is scoped THROUGH that parent
-- rather than carrying a copied tenant key, because a duplicated companyId is a
-- second source of truth that every future move-between-companies operation has to
-- remember to rewrite.
--
-- `projects.Site` is deliberately absent: 003 already gave it a tenant_isolation
-- policy, and this feature only added columns to it.

-- ── Company-level tables: direct companyId ──────────────────────────────────

ALTER TABLE "projects"."Client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."Client" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."Client"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."Project" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."Project"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- The five tables below each keep their own companyId as well as a projectId. Unlike
-- the child tables at the bottom they are queried company-wide as well as per
-- project — a BOQ alert sweep, a DWR register across sites, a revenue roll-up — and
-- scoping those through the parent would turn every such scan into a correlated
-- subquery per row for no integrity gain.

ALTER TABLE "projects"."BOQTaskGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BOQTaskGroup" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BOQTaskGroup"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."BOQTaskItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."BOQTaskItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."BOQTaskItem"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."DailyWorkReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."DailyWorkReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."DailyWorkReport"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."Revenue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."Revenue" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."Revenue"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."RABill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."RABill" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."RABill"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."WorkOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."WorkOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."WorkOrder"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."ProjectBudget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ProjectBudget" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ProjectBudget"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "projects"."ProjectDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."ProjectDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."ProjectDocument"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── DWR-owned table: scoped through the owning DailyWorkReport ──────────────
-- A measurement line carries no companyId of its own. It is reached only through its
-- report, which is already tenant-scoped above, and copying the key onto every task
-- row would create exactly the drift this pattern exists to avoid. DWRTask is indexed
-- on dwrId and DailyWorkReport on companyId, so the EXISTS stays an index lookup.

ALTER TABLE "projects"."DWRTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."DWRTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."DWRTask"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "projects"."DailyWorkReport" d
      WHERE d."id" = "DWRTask"."dwrId"
        AND d."companyId" = current_setting('app.current_company_id', true)
    )
  );
