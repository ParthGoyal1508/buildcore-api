-- DropIndex
DROP INDEX "projects"."RABill_projectId_billNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "RABill_workOrderId_billNumber_key" ON "projects"."RABill"("workOrderId", "billNumber");

