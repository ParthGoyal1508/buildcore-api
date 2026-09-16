-- AlterTable
ALTER TABLE "inventory"."Payment" ADD COLUMN     "proofRef" TEXT,
ADD COLUMN     "proofUploadedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Payment_companyId_proofRef_idx" ON "inventory"."Payment"("companyId", "proofRef");
