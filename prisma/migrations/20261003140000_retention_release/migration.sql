-- 018 Phase 7, 2026-10-03. Retention released back to a subcontractor (FR-016a).
--
-- The client confirmed on this date that release is an explicit act somebody performs, not a
-- schedule the system runs. They were offered two automatic schedules — half at practical
-- completion and half after defects, and a fixed number of days — and chose the manual release.
--
-- Nothing is backfilled and no existing figure changes. Retention has been withheld per RA bill
-- since the billing migration; what was missing was anywhere to record it going back, so every
-- work order starts with its whole withheld balance outstanding, which is the truth.

-- ── RLS context ──────────────────────────────────────────────────────────────
--
-- No data statements below, so strictly this is unnecessary — and it is here anyway, because the
-- class of defect it guards against is one local development cannot catch: production connects as
-- `buildcore_app` (NOSUPERUSER, NOBYPASSRLS) while local development connects as a SUPERUSER and
-- bypasses RLS entirely. Five migrations failed this way in production on 2026-09-16. Setting it
-- unconditionally is cheaper than deciding each time whether this is one of the migrations that
-- needs it.
SELECT set_config('app.is_super_admin', 'true', true);

CREATE TABLE "projects"."RetentionRelease" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "releasedOn" DATE NOT NULL,
    "reason" TEXT,
    "releasedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionRelease_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RetentionRelease_companyId_workOrderId_idx"
  ON "projects"."RetentionRelease"("companyId", "workOrderId");

ALTER TABLE "projects"."RetentionRelease"
  ADD CONSTRAINT "RetentionRelease_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "projects"."WorkOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A release is money, and money is never negative. The service refuses one exceeding the balance
-- still held; this catches the narrower case the service cannot — a caller reaching the table some
-- other way, now or in whatever script somebody writes next year.
ALTER TABLE "projects"."RetentionRelease"
  ADD CONSTRAINT "RetentionRelease_amount_positive" CHECK ("amount" > 0);

-- ── Tenant isolation ─────────────────────────────────────────────────────────
--
-- `WITH CHECK` as well as `USING`, for the reason the billing migration gives: a policy with only
-- `USING` filters reads and admits any write naming another tenant. `FORCE` so the table owner is
-- not exempt either.
ALTER TABLE "projects"."RetentionRelease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."RetentionRelease" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."RetentionRelease"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
