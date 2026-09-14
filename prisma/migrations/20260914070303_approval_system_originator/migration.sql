-- DropForeignKey
ALTER TABLE "shared"."ApprovalInstance" DROP CONSTRAINT "ApprovalInstance_originatorUserId_fkey";

-- AlterTable
ALTER TABLE "shared"."ApprovalInstance" ALTER COLUMN "originatorUserId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "shared"."ApprovalInstance" ADD CONSTRAINT "ApprovalInstance_originatorUserId_fkey" FOREIGN KEY ("originatorUserId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
