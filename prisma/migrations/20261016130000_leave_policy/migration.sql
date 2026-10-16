-- Leave policy, automatic crediting and adjustments (2026-10-16). Until now nothing in the
-- application wrote a leave balance's opening or accrued figure, so every employee had 0 earned,
-- casual and sick leave and could apply only for leave without pay.

CREATE TYPE "hr"."LeaveCreditMode" AS ENUM ('monthly', 'yearly');
CREATE TYPE "hr"."LeaveLedgerKind" AS ENUM ('monthly_credit', 'yearly_credit', 'carry_forward', 'adjustment', 'opening_import');

CREATE TABLE "hr"."LeavePolicy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leaveType" "hr"."LeaveTypeCode" NOT NULL,
    "annualDays" DECIMAL(6,2) NOT NULL,
    "creditMode" "hr"."LeaveCreditMode" NOT NULL,
    "carryForward" BOOLEAN NOT NULL DEFAULT false,
    "carryForwardCap" DECIMAL(6,2),
    "prorateJoiners" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeavePolicy_companyId_leaveType_key" ON "hr"."LeavePolicy"("companyId", "leaveType");

CREATE TABLE "hr"."LeaveLedgerEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" "hr"."LeaveTypeCode" NOT NULL,
    "financialYear" TEXT NOT NULL,
    "kind" "hr"."LeaveLedgerKind" NOT NULL,
    "period" TEXT NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeaveLedgerEntry_employeeId_leaveType_financialYear_kind_period_key" ON "hr"."LeaveLedgerEntry"("employeeId", "leaveType", "financialYear", "kind", "period");
CREATE INDEX "LeaveLedgerEntry_companyId_financialYear_idx" ON "hr"."LeaveLedgerEntry"("companyId", "financialYear");
ALTER TABLE "hr"."LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, as every tenant table has.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['LeavePolicy', 'LeaveLedgerEntry'] LOOP
    EXECUTE format('ALTER TABLE "hr".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE "hr".%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "tenant_isolation" ON "hr".%I
      USING (
        current_setting('app.is_super_admin', true) = 'true'
        OR "companyId" = current_setting('app.current_company_id', true)
      )
      WITH CHECK (
        current_setting('app.is_super_admin', true) = 'true'
        OR "companyId" = current_setting('app.current_company_id', true)
      )$p$, t);
  END LOOP;
END $$;
