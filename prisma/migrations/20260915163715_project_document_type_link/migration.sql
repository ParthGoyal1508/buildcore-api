-- AlterTable
ALTER TABLE "projects"."ProjectDocument" ADD COLUMN     "documentTypeId" TEXT;

-- CreateIndex
CREATE INDEX "ProjectDocument_companyId_projectId_documentTypeId_idx" ON "projects"."ProjectDocument"("companyId", "projectId", "documentTypeId");
