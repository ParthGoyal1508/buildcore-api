/*
  Warnings:

  - You are about to drop the column `companyId` on the `AttendanceModification` table. All the data in the column will be lost.
  - You are about to drop the column `companyId` on the `EmployeeDocument` table. All the data in the column will be lost.
  - You are about to drop the column `companyId` on the `EmployeeTransfer` table. All the data in the column will be lost.
  - You are about to drop the column `companyId` on the `ExitRecord` table. All the data in the column will be lost.
  - You are about to drop the column `companyId` on the `PayrollLineItem` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "hr"."AttendanceModification_companyId_idx";

-- DropIndex
DROP INDEX "hr"."EmployeeDocument_companyId_idx";

-- DropIndex
DROP INDEX "hr"."EmployeeTransfer_companyId_idx";

-- DropIndex
DROP INDEX "hr"."ExitRecord_companyId_idx";

-- DropIndex
DROP INDEX "payroll"."PayrollLineItem_companyId_idx";

-- AlterTable
ALTER TABLE "hr"."AttendanceModification" DROP COLUMN "companyId";

-- AlterTable
ALTER TABLE "hr"."EmployeeDocument" DROP COLUMN "companyId";

-- AlterTable
ALTER TABLE "hr"."EmployeeTransfer" DROP COLUMN "companyId";

-- AlterTable
ALTER TABLE "hr"."ExitRecord" DROP COLUMN "companyId";

-- AlterTable
ALTER TABLE "payroll"."PayrollLineItem" DROP COLUMN "companyId";
