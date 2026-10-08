-- AlterEnum
ALTER TYPE "projects"."DwrStatus" ADD VALUE 'returned';

-- AlterTable
ALTER TABLE "projects"."DailyWorkReport" ADD COLUMN     "returnReason" TEXT,
ADD COLUMN     "returnedAt" TIMESTAMP(3),
ADD COLUMN     "returnedByUserId" TEXT;
