-- AlterTable
ALTER TABLE "plant"."FuelEntry" ADD COLUMN     "siteId" TEXT;

-- CreateIndex
CREATE INDEX "FuelEntry_companyId_siteId_date_idx" ON "plant"."FuelEntry"("companyId", "siteId", "date");

