-- Generated salary bank sheets, kept with their file so the history can be downloaded again (2026-10-17).

-- CreateTable
CREATE TABLE "payroll"."BankSheetExport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "debitAccount" TEXT NOT NULL,
    "employeeCount" INTEGER NOT NULL,
    "transferTotal" DECIMAL(14,2) NOT NULL,
    "leftOffCount" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankSheetExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankSheetExport_companyId_createdAt_idx" ON "payroll"."BankSheetExport"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "BankSheetExport_payrollRunId_idx" ON "payroll"."BankSheetExport"("payrollRunId");


ALTER TABLE "payroll"."BankSheetExport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll"."BankSheetExport" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll"."BankSheetExport"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
