-- CreateEnum
CREATE TYPE "hr"."Gender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "hr"."MaritalStatus" AS ENUM ('single', 'married', 'divorced', 'widowed');

-- CreateEnum
CREATE TYPE "hr"."EmploymentType" AS ENUM ('full_time', 'contract', 'daily_wage');

-- CreateEnum
CREATE TYPE "hr"."CalculationMode" AS ENUM ('monthly', 'daily');

-- CreateEnum
CREATE TYPE "hr"."HolidayType" AS ENUM ('national', 'regional', 'company');

-- CreateEnum
CREATE TYPE "hr"."ExitReason" AS ENUM ('resignation', 'termination', 'contract_end');

-- CreateEnum
CREATE TYPE "payroll"."LoanStatus" AS ENUM ('pending', 'active', 'closed');

-- CreateEnum
CREATE TYPE "payroll"."LoanScheduleStatus" AS ENUM ('upcoming', 'paid', 'overdue');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EMPLOYEE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EMPLOYEE_DOCUMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EMPLOYEE_TRANSFER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ATTENDANCE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'HOLIDAY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PAYROLL_RUN';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LOAN';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'EXIT_RECORD';

-- DropIndex
DROP INDEX "payroll"."PayrollRun_companyId_idx";

-- DropIndex
DROP INDEX "payroll"."PayrollRun_companyId_period_key";

-- AlterTable
ALTER TABLE "hr"."Employee" ADD COLUMN     "aadhaarEncrypted" TEXT,
ADD COLUMN     "alternateMobile" TEXT,
ADD COLUMN     "appointmentLetterIssued" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "appointmentLetterIssuedDate" DATE,
ADD COLUMN     "bankAccountNumberEncrypted" TEXT,
ADD COLUMN     "bankBranch" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "bankVerificationDone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "basic" DECIMAL(12,2),
ADD COLUMN     "biometricEnrolled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "calculationMode" "hr"."CalculationMode" DEFAULT 'monthly',
ADD COLUMN     "confirmationDate" DATE,
ADD COLUMN     "conveyanceAllowance" DECIMAL(12,2),
ADD COLUMN     "dailyRate" DECIMAL(12,2),
ADD COLUMN     "dateOfJoining" DATE,
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "designationId" TEXT,
ADD COLUMN     "dob" DATE,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "emergencyContactRelation" TEXT,
ADD COLUMN     "employmentType" "hr"."EmploymentType" DEFAULT 'full_time',
ADD COLUMN     "esicApplicable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "esicNumber" TEXT,
ADD COLUMN     "esicUpperLimit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "gender" "hr"."Gender",
ADD COLUMN     "hoursPerDay" DECIMAL(4,2),
ADD COLUMN     "hra" DECIMAL(12,2),
ADD COLUMN     "idCardIssued" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ifscCode" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "maritalStatus" "hr"."MaritalStatus",
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "musterCategory" TEXT,
ADD COLUMN     "ndaSigned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ndaSignedDate" DATE,
ADD COLUMN     "offerLetterIssued" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offerLetterIssuedDate" DATE,
ADD COLUMN     "panEncrypted" TEXT,
ADD COLUMN     "payMode" TEXT,
ADD COLUMN     "paymentMode" TEXT,
ADD COLUMN     "permanentAddress" TEXT,
ADD COLUMN     "permanentCity" TEXT,
ADD COLUMN     "permanentPinCode" TEXT,
ADD COLUMN     "permanentState" TEXT,
ADD COLUMN     "pfApplicable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pfNumber" TEXT,
ADD COLUMN     "pfUpperLimit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "photoRef" TEXT,
ADD COLUMN     "presentAddress" TEXT,
ADD COLUMN     "presentCity" TEXT,
ADD COLUMN     "presentPinCode" TEXT,
ADD COLUMN     "presentState" TEXT,
ADD COLUMN     "probationEndDate" DATE,
ADD COLUMN     "reportingToEmployeeId" TEXT,
ADD COLUMN     "safetyInductionCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "siteAccessGranted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "siteAllowance" DECIMAL(12,2),
ADD COLUMN     "specialAllowance" DECIMAL(12,2),
ADD COLUMN     "title" TEXT,
ADD COLUMN     "toolsIssued" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "uan" TEXT,
ADD COLUMN     "uniformProvided" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workmanId" TEXT;

-- AlterTable
ALTER TABLE "payroll"."PayrollRun" ADD COLUMN     "generatedAt" TIMESTAMP(3),
ADD COLUMN     "generatedByUserId" TEXT,
ADD COLUMN     "isFnf" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "processedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settings"."Company" ADD COLUMN     "otMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 2.00;

-- CreateTable
CREATE TABLE "hr"."EmployeeDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "documentNumber" TEXT,
    "expiresAt" DATE,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."EmployeeTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromCompanyId" TEXT NOT NULL,
    "toCompanyId" TEXT NOT NULL,
    "transferDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "codeRetained" BOOLEAN NOT NULL DEFAULT false,
    "newEmployeeCode" TEXT,
    "transferredByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."Holiday" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "hr"."HolidayType" NOT NULL DEFAULT 'company',
    "appliesToAllSites" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."HolidaySite" (
    "holidayId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,

    CONSTRAINT "HolidaySite_pkey" PRIMARY KEY ("holidayId","siteId")
);

-- CreateTable
CREATE TABLE "hr"."AttendanceModification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceModification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."ExitRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "lastWorkingDay" DATE NOT NULL,
    "reason" "hr"."ExitReason" NOT NULL,
    "remarks" TEXT,
    "fnfPayrollRunId" TEXT,
    "initiatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExitRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll"."PayrollLineItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT,
    "monthDays" INTEGER NOT NULL,
    "payableDays" DECIMAL(6,2) NOT NULL,
    "lopDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "otHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "otWages" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "basic" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hra" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "conveyanceAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "siteAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "specialAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employeePf" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employeeEsic" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "professionalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tds" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "loanEmiDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employerPf" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employerEps" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employerEdli" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adminCharges" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employerEsic" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gratuity" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll"."Loan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "emiAmount" DECIMAL(12,2) NOT NULL,
    "disbursementDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "remarks" TEXT,
    "status" "payroll"."LoanStatus" NOT NULL DEFAULT 'pending',
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll"."LoanScheduleEntry" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "emiAmount" DECIMAL(12,2) NOT NULL,
    "principal" DECIMAL(12,2) NOT NULL,
    "interest" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remainingBalance" DECIMAL(12,2) NOT NULL,
    "status" "payroll"."LoanScheduleStatus" NOT NULL DEFAULT 'upcoming',
    "paidInPayrollRunId" TEXT,

    CONSTRAINT "LoanScheduleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeDocument_companyId_idx" ON "hr"."EmployeeDocument"("companyId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_expiresAt_idx" ON "hr"."EmployeeDocument"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocument_employeeId_documentTypeId_key" ON "hr"."EmployeeDocument"("employeeId", "documentTypeId");

-- CreateIndex
CREATE INDEX "EmployeeTransfer_companyId_idx" ON "hr"."EmployeeTransfer"("companyId");

-- CreateIndex
CREATE INDEX "EmployeeTransfer_employeeId_idx" ON "hr"."EmployeeTransfer"("employeeId");

-- CreateIndex
CREATE INDEX "Holiday_companyId_date_idx" ON "hr"."Holiday"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_companyId_date_name_key" ON "hr"."Holiday"("companyId", "date", "name");

-- CreateIndex
CREATE INDEX "HolidaySite_siteId_idx" ON "hr"."HolidaySite"("siteId");

-- CreateIndex
CREATE INDEX "AttendanceModification_companyId_idx" ON "hr"."AttendanceModification"("companyId");

-- CreateIndex
CREATE INDEX "AttendanceModification_employeeId_date_idx" ON "hr"."AttendanceModification"("employeeId", "date");

-- CreateIndex
CREATE INDEX "ExitRecord_companyId_idx" ON "hr"."ExitRecord"("companyId");

-- CreateIndex
CREATE INDEX "ExitRecord_employeeId_idx" ON "hr"."ExitRecord"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollLineItem_companyId_idx" ON "payroll"."PayrollLineItem"("companyId");

-- CreateIndex
CREATE INDEX "PayrollLineItem_employeeId_idx" ON "payroll"."PayrollLineItem"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollLineItem_projectId_idx" ON "payroll"."PayrollLineItem"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollLineItem_payrollRunId_employeeId_key" ON "payroll"."PayrollLineItem"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "Loan_companyId_idx" ON "payroll"."Loan"("companyId");

-- CreateIndex
CREATE INDEX "Loan_employeeId_status_idx" ON "payroll"."Loan"("employeeId", "status");

-- CreateIndex
CREATE INDEX "LoanScheduleEntry_status_idx" ON "payroll"."LoanScheduleEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LoanScheduleEntry_loanId_month_key" ON "payroll"."LoanScheduleEntry"("loanId", "month");

-- CreateIndex
CREATE INDEX "PayrollRun_companyId_period_idx" ON "payroll"."PayrollRun"("companyId", "period");

-- AddForeignKey
ALTER TABLE "hr"."EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."EmployeeTransfer" ADD CONSTRAINT "EmployeeTransfer_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."HolidaySite" ADD CONSTRAINT "HolidaySite_holidayId_fkey" FOREIGN KEY ("holidayId") REFERENCES "hr"."Holiday"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."AttendanceModification" ADD CONSTRAINT "AttendanceModification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."ExitRecord" ADD CONSTRAINT "ExitRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll"."PayrollLineItem" ADD CONSTRAINT "PayrollLineItem_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll"."PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll"."PayrollLineItem" ADD CONSTRAINT "PayrollLineItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll"."Loan" ADD CONSTRAINT "Loan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll"."LoanScheduleEntry" ADD CONSTRAINT "LoanScheduleEntry_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "payroll"."Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written additions (feature 005). Prisma cannot express either of these.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Partial unique index on PayrollRun.
--    One regular run per (companyId, period), but MANY F&F runs per period —
--    one per exiting employee. A plain compound unique would forbid the second
--    exit in a month, so the constraint is scoped to non-F&F rows only.
CREATE UNIQUE INDEX "PayrollRun_companyId_period_regular_key"
  ON "payroll"."PayrollRun" ("companyId", "period")
  WHERE "isFnf" = false;

-- 2. Migrate existing projects.Site.holidays (DateTime[]) into the new
--    hr.Holiday / hr.HolidaySite calendar (research.md §6). Expand phase only —
--    the old column is dropped in a later migration, once the reading code has
--    moved over, so a mid-deploy rollback stays safe.
INSERT INTO "hr"."Holiday" ("id", "companyId", "name", "date", "type", "appliesToAllSites", "createdAt", "updatedAt")
SELECT DISTINCT ON (s."companyId", h.d)
       gen_random_uuid()::text,
       s."companyId",
       'Migrated site holiday',
       h.d,
       'company',
       false,
       NOW(),
       NOW()
FROM "projects"."Site" s
CROSS JOIN LATERAL unnest(s."holidays") AS h(d)
ON CONFLICT ("companyId", "date", "name") DO NOTHING;

INSERT INTO "hr"."HolidaySite" ("holidayId", "siteId")
SELECT DISTINCT hol."id", s."id"
FROM "projects"."Site" s
CROSS JOIN LATERAL unnest(s."holidays") AS h(d)
JOIN "hr"."Holiday" hol
  ON hol."companyId" = s."companyId"
 AND hol."date" = h.d
 AND hol."name" = 'Migrated site holiday'
ON CONFLICT DO NOTHING;
