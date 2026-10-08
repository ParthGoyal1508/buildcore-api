-- AlterEnum
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'DEBIT_NOTE';

-- AlterTable
ALTER TABLE "projects"."BillPackageDebit" ADD COLUMN     "noteNumber" TEXT;

