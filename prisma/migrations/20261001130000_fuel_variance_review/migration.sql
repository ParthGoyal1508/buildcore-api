-- 020 Phases 5 and 6, 2026-10-01. Fuel variance becomes reviewable, and then consequential
-- (FR-001 to FR-010).
--
-- **Detection is untouched** (FR-017). `Equipment.fuelBenchmark`, `FuelEntry.variancePercent` and
-- `FuelEntry.varianceAlert` keep computing exactly as they did. What these tables add is the review
-- that turns an alert nobody must act on into a decision with a name against it, and the two
-- consequences that decision can have.
--
-- One migration for both phases: they share a foreign key in each direction and splitting them would
-- leave an intermediate state where the exception table names tables that do not exist.
--
-- Additive, no backfill, no data statement, so no `set_config` guard.

CREATE TYPE "plant"."FuelExceptionStatus" AS ENUM ('open', 'confirmed', 'dismissed');

-- `neither` is a value rather than a null: confirming an exception and pursuing nobody is a decision
-- somebody made, and it must be distinguishable from one nobody has reviewed.
CREATE TYPE "plant"."FuelAttribution" AS ENUM ('hirer', 'operator', 'neither');

CREATE TYPE "plant"."OperatorRecoveryStatus" AS ENUM (
  'pending_approval', 'approved', 'applied', 'rejected', 'reversed'
);

CREATE TABLE "plant"."FuelVarianceException" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fuelEntryId" TEXT NOT NULL,
    "status" "plant"."FuelExceptionStatus" NOT NULL DEFAULT 'open',
    -- No DEFAULT, deliberately (plan D27). A default would decide, quietly and at scale, who pays
    -- for fuel nobody can account for.
    "attribution" "plant"."FuelAttribution",
    "operatorEmployeeId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FuelVarianceException_pkey" PRIMARY KEY ("id")
);

-- One alert raises one exception. A second row for the same reading would be two reviews of one
-- fact, and the two could disagree.
CREATE UNIQUE INDEX "FuelVarianceException_fuelEntryId_key"
  ON "plant"."FuelVarianceException"("fuelEntryId");
CREATE INDEX "FuelVarianceException_companyId_status_idx"
  ON "plant"."FuelVarianceException"("companyId", "status");

ALTER TABLE "plant"."FuelVarianceException"
  ADD CONSTRAINT "FuelVarianceException_fuelEntryId_fkey"
  FOREIGN KEY ("fuelEntryId") REFERENCES "plant"."FuelEntry"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "plant"."HireBillDeduction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hireBillId" TEXT NOT NULL,
    "fuelVarianceExceptionId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HireBillDeduction_pkey" PRIMARY KEY ("id")
);

-- One exception cannot be recovered twice from a bill.
CREATE UNIQUE INDEX "HireBillDeduction_fuelVarianceExceptionId_key"
  ON "plant"."HireBillDeduction"("fuelVarianceExceptionId");
CREATE INDEX "HireBillDeduction_companyId_hireBillId_idx"
  ON "plant"."HireBillDeduction"("companyId", "hireBillId");

ALTER TABLE "plant"."HireBillDeduction"
  ADD CONSTRAINT "HireBillDeduction_hireBillId_fkey"
  FOREIGN KEY ("hireBillId") REFERENCES "plant"."HireBill"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plant"."HireBillDeduction"
  ADD CONSTRAINT "HireBillDeduction_fuelVarianceExceptionId_fkey"
  FOREIGN KEY ("fuelVarianceExceptionId") REFERENCES "plant"."FuelVarianceException"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "plant"."OperatorFuelRecovery" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fuelVarianceExceptionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "plant"."OperatorRecoveryStatus" NOT NULL DEFAULT 'pending_approval',
    "approvalItemId" TEXT,
    "appliedPayrollLineItemId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorFuelRecovery_pkey" PRIMARY KEY ("id")
);

-- The other half of FR-002's exclusivity: one exception, one recovery.
CREATE UNIQUE INDEX "OperatorFuelRecovery_fuelVarianceExceptionId_key"
  ON "plant"."OperatorFuelRecovery"("fuelVarianceExceptionId");
CREATE INDEX "OperatorFuelRecovery_companyId_status_idx"
  ON "plant"."OperatorFuelRecovery"("companyId", "status");
CREATE INDEX "OperatorFuelRecovery_companyId_employeeId_idx"
  ON "plant"."OperatorFuelRecovery"("companyId", "employeeId");

ALTER TABLE "plant"."OperatorFuelRecovery"
  ADD CONSTRAINT "OperatorFuelRecovery_fuelVarianceExceptionId_fkey"
  FOREIGN KEY ("fuelVarianceExceptionId") REFERENCES "plant"."FuelVarianceException"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- `employeeId` carries no foreign key: `hr.Employee` lives in another schema and `plant` does not
-- reach into it (Principle I). The reference is resolved through `EmployeesService`, the same way
-- every other cross-module reference in this codebase is.

-- All three hold money decisions about a named company, and the recovery names a person.
-- WITH CHECK written explicitly rather than left to default from USING.
ALTER TABLE "plant"."FuelVarianceException" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."FuelVarianceException" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."FuelVarianceException"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "plant"."HireBillDeduction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."HireBillDeduction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."HireBillDeduction"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

ALTER TABLE "plant"."OperatorFuelRecovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."OperatorFuelRecovery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."OperatorFuelRecovery"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );
