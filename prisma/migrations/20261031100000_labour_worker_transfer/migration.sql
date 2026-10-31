-- AlterTable
ALTER TABLE "labour"."PaymentSheetLine" ADD COLUMN     "contractorId" TEXT;

-- CreateTable
CREATE TABLE "labour"."LabourWorkerTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "fromSiteId" TEXT NOT NULL,
    "toSiteId" TEXT NOT NULL,
    "transferredOn" DATE NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabourWorkerTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabourWorkerTransfer_companyId_idx" ON "labour"."LabourWorkerTransfer"("companyId");

-- CreateIndex
CREATE INDEX "LabourWorkerTransfer_workerId_transferredOn_idx" ON "labour"."LabourWorkerTransfer"("workerId", "transferredOn");

-- AddForeignKey
ALTER TABLE "labour"."LabourWorkerTransfer" ADD CONSTRAINT "LabourWorkerTransfer_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "labour"."LabourWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The standard tenant policy every labour table carries.
ALTER TABLE "labour"."LabourWorkerTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour"."LabourWorkerTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labour"."LabourWorkerTransfer"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
