-- AlterTable
ALTER TABLE "projects"."ClientBill" ADD COLUMN     "certificateFileName" TEXT,
ADD COLUMN     "certificateFileRef" TEXT,
ADD COLUMN     "certificateMimeType" TEXT,
ADD COLUMN     "certificateSizeBytes" INTEGER;

-- AlterTable
ALTER TABLE "projects"."ClientBillLine" ADD COLUMN     "certifiedQty" DECIMAL(18,3);

