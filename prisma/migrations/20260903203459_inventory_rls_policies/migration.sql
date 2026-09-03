-- Row-level security for feature 009's thirteen tables (Constitution Principle IV),
-- reusing verbatim the session-variable pattern established in
-- 20260829073000_settings_rls_policies and extended by every feature since, set by
-- src/common/prisma/rls-context.ts.
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception every feature since 001 takes.
--
-- Every one of these is the standard equality test. Unlike 004's ReminderRule there
-- is no cross-tenant catalogue row here: an item, a category and a stock balance all
-- belong to exactly one company, and the two `settings`-schema masters are scoped the
-- same way `VendorCategory` already is.

-- ── settings masters (research.md §1) ───────────────────────────────────────

ALTER TABLE "settings"."ItemCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."ItemCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."ItemCategory"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "settings"."Item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."Item" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."Item"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── inventory operational tables ────────────────────────────────────────────
--
-- `PaymentAllocation` carries its own `companyId` rather than inheriting scope
-- through its payment: a policy that had to join to another table to decide would be
-- evaluated per row on every read, and a denormalised column the writer always sets
-- is both cheaper and impossible to get wrong at read time.

ALTER TABLE "inventory"."StockBalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."StockBalance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."StockBalance"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."StockLedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."StockLedgerEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."StockLedgerEntry"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."Purchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."Purchase" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."Purchase"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."GoodsReceiptNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."GoodsReceiptNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."GoodsReceiptNote"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."PurchaseBill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."PurchaseBill" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."PurchaseBill"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."Issue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."Issue" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."Issue"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."StockTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."StockTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."StockTransfer"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."Payment"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."PaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."PaymentAllocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."PaymentAllocation"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."MaterialIndent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."MaterialIndent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."MaterialIndent"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

ALTER TABLE "inventory"."MaterialIndentLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."MaterialIndentLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory"."MaterialIndentLine"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
