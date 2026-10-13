-- DropForeignKey
ALTER TABLE "projects"."BillPackageCheckListAnswer" DROP CONSTRAINT "BillPackageCheckListAnswer_packageId_fkey";

-- DropTable
DROP TABLE "projects"."BillPackageCheckListAnswer";

-- DropEnum
DROP TYPE "projects"."CheckListAnswer";

