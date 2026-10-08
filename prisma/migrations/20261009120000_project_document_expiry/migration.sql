-- AlterTable
ALTER TABLE "projects"."ProjectDocument" ADD COLUMN     "documentNumber" TEXT,
ADD COLUMN     "expiresAt" DATE;

-- AlterTable
ALTER TABLE "projects"."StagedProjectDocument" ADD COLUMN     "documentNumber" TEXT,
ADD COLUMN     "expiresAt" DATE;

-- CreateIndex
CREATE INDEX "ProjectDocument_companyId_expiresAt_idx" ON "projects"."ProjectDocument"("companyId", "expiresAt");

