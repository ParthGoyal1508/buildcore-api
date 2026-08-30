-- CreateEnum
CREATE TYPE "settings"."CompanyStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "settings"."PayCycle" AS ENUM ('monthly');

-- AlterTable
ALTER TABLE "shared"."User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "settings"."Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "logoUrl" TEXT,
    "status" "settings"."CompanyStatus" NOT NULL DEFAULT 'active',
    "gstin" TEXT,
    "pan" TEXT,
    "cin" TEXT,
    "tan" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pinCode" TEXT,
    "pfEstablishmentCode" TEXT,
    "esicCode" TEXT,
    "professionalTaxRegNumber" TEXT,
    "bocwRegNumber" TEXT,
    "payCycle" "settings"."PayCycle" NOT NULL DEFAULT 'monthly',
    "payrollLockDay" INTEGER NOT NULL,
    "pfEmployerRate" DECIMAL(5,2) NOT NULL,
    "esicEmployerRate" DECIMAL(5,2) NOT NULL,
    "gratuityRate" DECIMAL(5,2) NOT NULL,
    "bonusRate" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."Department" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."Designation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Designation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."DocumentType" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "hasExpiry" BOOLEAN NOT NULL DEFAULT false,
    "needsNumber" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."Shift" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inTime" TIME(0) NOT NULL,
    "outTime" TIME(0) NOT NULL,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."EmployeeCodeSequence" (
    "companyId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmployeeCodeSequence_pkey" PRIMARY KEY ("companyId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_shortCode_key" ON "settings"."Company"("shortCode");

-- CreateIndex
CREATE INDEX "Department_companyId_idx" ON "settings"."Department"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_name_key" ON "settings"."Department"("companyId", "name");

-- CreateIndex
CREATE INDEX "Designation_companyId_idx" ON "settings"."Designation"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Designation_companyId_name_key" ON "settings"."Designation"("companyId", "name");

-- CreateIndex
CREATE INDEX "DocumentType_companyId_idx" ON "settings"."DocumentType"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_companyId_code_key" ON "settings"."DocumentType"("companyId", "code");

-- CreateIndex
CREATE INDEX "Shift_companyId_idx" ON "settings"."Shift"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_companyId_name_key" ON "settings"."Shift"("companyId", "name");

-- AddForeignKey
ALTER TABLE "settings"."Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."Designation" ADD CONSTRAINT "Designation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."DocumentType" ADD CONSTRAINT "DocumentType_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."Shift" ADD CONSTRAINT "Shift_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."EmployeeCodeSequence" ADD CONSTRAINT "EmployeeCodeSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
