-- AlterTable
ALTER TABLE "projects"."DWRAttachment" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "DWRAttachment_taskId_idx" ON "projects"."DWRAttachment"("taskId");

-- AddForeignKey
ALTER TABLE "projects"."DWRAttachment" ADD CONSTRAINT "DWRAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "projects"."DWRTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

