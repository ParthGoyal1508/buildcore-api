-- AlterTable
ALTER TABLE "projects"."DailyWorkReport" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedByUserId" TEXT;
