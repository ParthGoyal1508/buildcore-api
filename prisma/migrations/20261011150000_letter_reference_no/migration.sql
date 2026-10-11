-- AlterTable
ALTER TABLE "shared"."IssuedLetter" ADD COLUMN     "referenceNo" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IssuedLetter_companyId_referenceNo_key" ON "shared"."IssuedLetter"("companyId", "referenceNo");

