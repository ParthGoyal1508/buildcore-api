-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "hr";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payroll";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "projects";

-- CreateEnum
CREATE TYPE "hr"."FaceEnrolmentStatus" AS ENUM ('not_enrolled', 'enrolled', 're_enrolment_requested');

-- CreateEnum
CREATE TYPE "hr"."ConsentMethod" AS ENUM ('signed_paper', 'digital', 'verbal');

-- CreateEnum
CREATE TYPE "hr"."ReEnrolmentRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'completed', 'expired');

-- CreateEnum
CREATE TYPE "hr"."PunchType" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "hr"."FaceMatchResult" AS ENUM ('matched', 'exception');

-- CreateEnum
CREATE TYPE "hr"."GeofenceResult" AS ENUM ('in_range', 'exception');

-- CreateEnum
CREATE TYPE "hr"."ExceptionResolution" AS ENUM ('pending', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "hr"."LeaveTypeCode" AS ENUM ('earned', 'casual', 'sick', 'lwp');

-- CreateEnum
CREATE TYPE "hr"."LeaveApplicationStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "payroll"."PayrollRunStatus" AS ENUM ('draft', 'processed', 'paid');

-- AlterEnum
ALTER TYPE "shared"."AuditAction" ADD VALUE 'READ';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PUNCH';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LEAVE_APPLICATION';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'FACE_ENROLMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'RE_ENROLMENT_REQUEST';

-- CreateTable
CREATE TABLE "projects"."Site" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "geofenceRadiusMeters" INTEGER NOT NULL,
    "weeklyOffDay" INTEGER NOT NULL,
    "holidays" DATE[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."Employee" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."FaceEnrolment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "descriptor" BYTEA,
    "photoRefs" TEXT[],
    "consentMethod" "hr"."ConsentMethod",
    "consentAcknowledgedAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "status" "hr"."FaceEnrolmentStatus" NOT NULL DEFAULT 'not_enrolled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaceEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."ReEnrolmentRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "hr"."ReEnrolmentRequestStatus" NOT NULL DEFAULT 'pending',
    "adminRemarks" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "unlockExpiresAt" TIMESTAMP(3),
    "unlockConsumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReEnrolmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."PunchRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "hr"."PunchType" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isOfflineSync" BOOLEAN NOT NULL DEFAULT false,
    "photoRef" TEXT NOT NULL,
    "faceMatchResult" "hr"."FaceMatchResult" NOT NULL,
    "faceMatchDistance" DECIMAL(6,4),
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "geofenceResult" "hr"."GeofenceResult" NOT NULL,
    "geofenceDistanceMeters" DECIMAL(10,2),
    "closedByPunchId" TEXT,
    "exceptionResolution" "hr"."ExceptionResolution",
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PunchRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."LeaveBalance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" "hr"."LeaveTypeCode" NOT NULL,
    "financialYear" TEXT NOT NULL,
    "opening" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "accrued" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "used" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr"."LeaveApplication" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" "hr"."LeaveTypeCode" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "dayCount" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "hr"."LeaveApplicationStatus" NOT NULL DEFAULT 'pending',
    "adminRemarks" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll"."PayrollRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "payroll"."PayrollRunStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Site_companyId_idx" ON "projects"."Site"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_companyId_name_key" ON "projects"."Site"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "hr"."Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_companyId_idx" ON "hr"."Employee"("companyId");

-- CreateIndex
CREATE INDEX "Employee_siteId_idx" ON "hr"."Employee"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_companyId_employeeCode_key" ON "hr"."Employee"("companyId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "FaceEnrolment_employeeId_key" ON "hr"."FaceEnrolment"("employeeId");

-- CreateIndex
CREATE INDEX "ReEnrolmentRequest_employeeId_status_idx" ON "hr"."ReEnrolmentRequest"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PunchRecord_closedByPunchId_key" ON "hr"."PunchRecord"("closedByPunchId");

-- CreateIndex
CREATE INDEX "PunchRecord_employeeId_capturedAt_idx" ON "hr"."PunchRecord"("employeeId", "capturedAt");

-- CreateIndex
CREATE INDEX "PunchRecord_exceptionResolution_idx" ON "hr"."PunchRecord"("exceptionResolution");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_employeeId_leaveType_financialYear_key" ON "hr"."LeaveBalance"("employeeId", "leaveType", "financialYear");

-- CreateIndex
CREATE INDEX "LeaveApplication_employeeId_status_idx" ON "hr"."LeaveApplication"("employeeId", "status");

-- CreateIndex
CREATE INDEX "LeaveApplication_employeeId_fromDate_toDate_idx" ON "hr"."LeaveApplication"("employeeId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "PayrollRun_companyId_idx" ON "payroll"."PayrollRun"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_companyId_period_key" ON "payroll"."PayrollRun"("companyId", "period");

-- AddForeignKey
ALTER TABLE "hr"."FaceEnrolment" ADD CONSTRAINT "FaceEnrolment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."ReEnrolmentRequest" ADD CONSTRAINT "ReEnrolmentRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."PunchRecord" ADD CONSTRAINT "PunchRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."LeaveBalance" ADD CONSTRAINT "LeaveBalance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr"."LeaveApplication" ADD CONSTRAINT "LeaveApplication_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr"."Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
