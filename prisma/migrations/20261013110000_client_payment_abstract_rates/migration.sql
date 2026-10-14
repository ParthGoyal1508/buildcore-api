-- AlterTable
ALTER TABLE "projects"."BillPackage" ADD COLUMN     "gstTdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "gstTdsAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "gstTdsFraction" DECIMAL(8,6) NOT NULL DEFAULT 0,
ADD COLUMN     "labourCessAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "labourCessAmountUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "labourCessFraction" DECIMAL(8,6) NOT NULL DEFAULT 0,
ADD COLUMN     "workDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "workDeductionUptoDate" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "settings"."Company" ADD COLUMN     "gstTdsFraction" DECIMAL(8,6) NOT NULL DEFAULT 0.020000;

