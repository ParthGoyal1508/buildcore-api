-- Row-level security for feature 004's three reminders tables, reusing verbatim the
-- session-variable pattern established in 20260829073000_settings_rls_policies and
-- extended by 003, 005, 007 and 008, set by src/common/prisma/rls-context.ts
-- (Constitution Principle IV).
--
-- Policy-only migration: Prisma models RLS nowhere in schema.prisma, so this is
-- necessarily hand-authored SQL — the same exception every feature since 001 takes.

-- ── ReminderRule ────────────────────────────────────────────────────────────
--
-- The one table here whose policy is NOT the standard equality test. A rule row with
-- a NULL companyId is the code-declared catalogue entry that applies to every tenant
-- (see the model comment in schema.prisma), so every company must be able to read it
-- — otherwise the engine, running under a company context, would evaluate nothing at
-- all. A non-null companyId is a per-company override and is scoped normally.
--
-- The NULL rows are written only by `ReminderRuleRegistry`'s boot-time sync, which
-- runs under the cross-company bypass; no request-scoped caller can create one,
-- because the sync is the only writer.
ALTER TABLE "shared"."ReminderRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ReminderRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ReminderRule"
  USING (
    "companyId" IS NULL
    OR "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── ReminderSnooze ──────────────────────────────────────────────────────────

ALTER TABLE "shared"."ReminderSnooze" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ReminderSnooze" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ReminderSnooze"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- ── ReminderNotification ────────────────────────────────────────────────────

ALTER TABLE "shared"."ReminderNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."ReminderNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."ReminderNotification"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
