-- AlterTable
ALTER TABLE "shared"."ApprovalInstance" ADD COLUMN     "delegatedToUserId" TEXT,
ADD COLUMN     "delegationReason" TEXT;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalInstance" ADD CONSTRAINT "ApprovalInstance_delegatedToUserId_fkey" FOREIGN KEY ("delegatedToUserId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
