-- CreateIndex
CREATE UNIQUE INDEX "RABill_projectId_billNumber_key" ON "projects"."RABill"("projectId", "billNumber");

