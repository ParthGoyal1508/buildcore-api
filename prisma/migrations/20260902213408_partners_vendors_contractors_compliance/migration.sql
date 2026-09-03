-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "partners";

-- CreateEnum
CREATE TYPE "settings"."CodeSeriesType" AS ENUM ('VENDORS');

-- CreateEnum
CREATE TYPE "partners"."VendorType" AS ENUM ('material', 'fuel', 'hire', 'service', 'subcontractor', 'labour_contractor');

-- CreateEnum
CREATE TYPE "partners"."HireType" AS ENUM ('taken', 'given');

-- CreateEnum
CREATE TYPE "partners"."ChargesBase" AS ENUM ('monthly', 'daily');

-- CreateEnum
CREATE TYPE "partners"."ContractorComplianceStatus" AS ENUM ('compliant', 'partially_compliant', 'non_compliant');

-- CreateEnum
CREATE TYPE "partners"."ContractorDocumentType" AS ENUM ('labour_license', 'pf_registration', 'esic_registration', 'insurance', 'bocw_registration');

-- CreateEnum
CREATE TYPE "partners"."MonthlyComplianceStatus" AS ENUM ('missing', 'partial', 'submitted', 'verified');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'VENDOR';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'VENDOR_CATEGORY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CONTRACTOR_PROFILE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CONTRACTOR_DOCUMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'MONTHLY_COMPLIANCE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'BOCW_PAYMENT';

-- AlterTable
ALTER TABLE "settings"."Company" ADD COLUMN     "bocwCessRate" DECIMAL(6,4) NOT NULL DEFAULT 0.0100;

-- CreateTable
CREATE TABLE "settings"."CodeSequence" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "seriesType" "settings"."CodeSeriesType" NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."VendorCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."Vendor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "partners"."VendorType" NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "tdsSection" TEXT,
    "tdsRate" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pinCode" TEXT,
    "vendorCurrency" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(12,6) NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."VendorContact" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."VendorDealsIn" (
    "vendorId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "VendorDealsIn_pkey" PRIMARY KEY ("vendorId","categoryId")
);

-- CreateTable
CREATE TABLE "partners"."VendorHireDetail" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "hireType" "partners"."HireType" NOT NULL,
    "contractCode" TEXT,
    "periodFrom" DATE,
    "periodTo" DATE,
    "machineCategory" TEXT,
    "machineName" TEXT,
    "requiredAvg" DECIMAL(12,2),
    "chargesBase" "partners"."ChargesBase" NOT NULL DEFAULT 'monthly',
    "rate" DECIMAL(12,2),
    "minWorkingDays" INTEGER,
    "allowBdDays" BOOLEAN NOT NULL DEFAULT false,
    "allowIdleDays" BOOLEAN NOT NULL DEFAULT false,
    "operatorCharges" DECIMAL(12,2),
    "helperCharges" DECIMAL(12,2),
    "maintenanceCharges" DECIMAL(12,2),
    "fuelCharges" DECIMAL(12,2),
    "termsAndConditions" TEXT,
    "requirements" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorHireDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."ContractorProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "licenceNumber" TEXT,
    "pfRegistration" TEXT,
    "esicRegistration" TEXT,
    "bocwRegistration" TEXT,
    "insurancePolicyNumber" TEXT,
    "complianceStatus" "partners"."ContractorComplianceStatus" NOT NULL DEFAULT 'non_compliant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."ContractorDocument" (
    "id" TEXT NOT NULL,
    "contractorProfileId" TEXT NOT NULL,
    "documentType" "partners"."ContractorDocumentType" NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT,
    "expiresAt" DATE,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."MonthlyCompliance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractorProfileId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "pfChallanNumber" TEXT,
    "pfAmount" DECIMAL(12,2),
    "pfDate" DATE,
    "esicChallanNumber" TEXT,
    "esicAmount" DECIMAL(12,2),
    "esicDate" DATE,
    "status" "partners"."MonthlyComplianceStatus" NOT NULL DEFAULT 'missing',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyCompliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners"."BOCWPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "amountPaid" DECIMAL(14,2) NOT NULL,
    "paymentDate" DATE NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "remarks" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BOCWPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodeSequence_companyId_seriesType_key" ON "settings"."CodeSequence"("companyId", "seriesType");

-- CreateIndex
CREATE INDEX "VendorCategory_companyId_idx" ON "settings"."VendorCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorCategory_companyId_name_key" ON "settings"."VendorCategory"("companyId", "name");

-- CreateIndex
CREATE INDEX "Vendor_companyId_idx" ON "partners"."Vendor"("companyId");

-- CreateIndex
CREATE INDEX "Vendor_companyId_type_idx" ON "partners"."Vendor"("companyId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_companyId_code_key" ON "partners"."Vendor"("companyId", "code");

-- CreateIndex
CREATE INDEX "VendorContact_vendorId_idx" ON "partners"."VendorContact"("vendorId");

-- CreateIndex
CREATE INDEX "VendorDealsIn_categoryId_idx" ON "partners"."VendorDealsIn"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorHireDetail_vendorId_key" ON "partners"."VendorHireDetail"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorProfile_vendorId_key" ON "partners"."ContractorProfile"("vendorId");

-- CreateIndex
CREATE INDEX "ContractorProfile_companyId_idx" ON "partners"."ContractorProfile"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorProfile_companyId_vendorId_key" ON "partners"."ContractorProfile"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "ContractorDocument_contractorProfileId_idx" ON "partners"."ContractorDocument"("contractorProfileId");

-- CreateIndex
CREATE INDEX "MonthlyCompliance_companyId_month_idx" ON "partners"."MonthlyCompliance"("companyId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyCompliance_contractorProfileId_month_key" ON "partners"."MonthlyCompliance"("contractorProfileId", "month");

-- CreateIndex
CREATE INDEX "BOCWPayment_companyId_projectId_idx" ON "partners"."BOCWPayment"("companyId", "projectId");

-- AddForeignKey
ALTER TABLE "settings"."CodeSequence" ADD CONSTRAINT "CodeSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."VendorCategory" ADD CONSTRAINT "VendorCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."VendorContact" ADD CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "partners"."Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."VendorDealsIn" ADD CONSTRAINT "VendorDealsIn_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "partners"."Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."VendorHireDetail" ADD CONSTRAINT "VendorHireDetail_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "partners"."Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."ContractorProfile" ADD CONSTRAINT "ContractorProfile_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "partners"."Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."ContractorDocument" ADD CONSTRAINT "ContractorDocument_contractorProfileId_fkey" FOREIGN KEY ("contractorProfileId") REFERENCES "partners"."ContractorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners"."MonthlyCompliance" ADD CONSTRAINT "MonthlyCompliance_contractorProfileId_fkey" FOREIGN KEY ("contractorProfileId") REFERENCES "partners"."ContractorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
