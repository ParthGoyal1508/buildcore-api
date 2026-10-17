-- 031 labour face attendance: supervisors punch labour in and out with a face match, HR sets a
-- male and a female daily rate per site, supervisors are assigned the sites they work, and the
-- labour code comes from a per-company counter instead of count()+1.
--
-- Enum values added here (MusterSource.face_punch, RateSource.site_rate) are not used in this
-- migration, so adding them inside its transaction is safe.

-- CreateEnum
CREATE TYPE "labour"."LabourGender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "labour"."LabourPunchType" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "labour"."LabourPunchRefusalReason" AS ENUM ('outside_geofence', 'unlocatable', 'face_mismatch', 'no_face_detected');

-- AlterEnum
ALTER TYPE "labour"."MusterSource" ADD VALUE 'face_punch';

-- AlterEnum
ALTER TYPE "labour"."RateSource" ADD VALUE 'site_rate';

-- AlterTable
ALTER TABLE "labour"."LabourWorker" ADD COLUMN     "fatherName" TEXT,
ALTER COLUMN "phone" DROP NOT NULL,
ALTER COLUMN "gender" DROP NOT NULL,
ALTER COLUMN "dateOfBirth" DROP NOT NULL,
ALTER COLUMN "skillCategoryId" DROP NOT NULL,
ALTER COLUMN "engagementType" SET DEFAULT 'direct';

-- Gender was free text. Converted in place rather than dropped and re-added so no worker loses it:
-- the spellings a form could plausibly have stored read as male/female, anything else becomes null
-- (that worker cannot be priced until somebody sets it, which the payment sheet says by name).
ALTER TABLE "labour"."LabourWorker" ALTER COLUMN "gender" TYPE "labour"."LabourGender" USING (
  CASE lower(btrim("gender"))
    WHEN 'male' THEN 'male'
    WHEN 'm' THEN 'male'
    WHEN 'female' THEN 'female'
    WHEN 'f' THEN 'female'
    ELSE NULL
  END
)::"labour"."LabourGender";

-- AlterTable
ALTER TABLE "labour"."MusterLine" ALTER COLUMN "skillCategoryIdOnDay" DROP NOT NULL;

-- AlterTable
ALTER TABLE "labour"."LabourPaymentSheet" ADD COLUMN     "siteId" TEXT,
ALTER COLUMN "projectId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "labour"."SiteWageRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "gender" "labour"."LabourGender" NOT NULL,
    "dailyRate" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "SiteWageRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."SupervisorSite" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "SupervisorSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourCodeSequence" (
    "companyId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LabourCodeSequence_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "labour"."LabourPunch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "punchDate" DATE NOT NULL,
    "type" "labour"."LabourPunchType" NOT NULL,
    "punchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supervisorId" TEXT NOT NULL,
    "photoRef" TEXT NOT NULL,
    "faceMatchDistance" DECIMAL(6,4) NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "accuracyMetres" DECIMAL(8,2),
    "geofenceDistanceMetres" DECIMAL(10,2) NOT NULL,
    "geofenceViolation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabourPunch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourPunchRefusal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "type" "labour"."LabourPunchType" NOT NULL,
    "reason" "labour"."LabourPunchRefusalReason" NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "accuracyMetres" DECIMAL(8,2),
    "distanceMetres" DECIMAL(10,2),
    "faceMatchDistance" DECIMAL(6,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabourPunchRefusal_pkey" PRIMARY KEY ("id")
);

-- Start each company's counter at the highest LAB-nnnn already issued, so the first code the
-- sequence hands out follows the last one the old count-based allocator did.
INSERT INTO "labour"."LabourCodeSequence" ("companyId", "lastNumber")
SELECT "companyId", COALESCE(MAX(NULLIF(regexp_replace("labourCode", '[^0-9]', '', 'g'), '')::int), 0)
FROM "labour"."LabourWorker"
GROUP BY "companyId";

-- CreateIndex
CREATE INDEX "SiteWageRate_companyId_idx" ON "labour"."SiteWageRate"("companyId");

-- CreateIndex
CREATE INDEX "SiteWageRate_companyId_siteId_gender_effectiveFrom_idx" ON "labour"."SiteWageRate"("companyId", "siteId", "gender", "effectiveFrom");

-- CreateIndex
CREATE INDEX "SupervisorSite_companyId_idx" ON "labour"."SupervisorSite"("companyId");

-- CreateIndex
CREATE INDEX "SupervisorSite_companyId_siteId_idx" ON "labour"."SupervisorSite"("companyId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SupervisorSite_userId_siteId_key" ON "labour"."SupervisorSite"("userId", "siteId");

-- CreateIndex
CREATE INDEX "LabourPunch_companyId_idx" ON "labour"."LabourPunch"("companyId");

-- CreateIndex
CREATE INDEX "LabourPunch_companyId_siteId_punchDate_idx" ON "labour"."LabourPunch"("companyId", "siteId", "punchDate");

-- CreateIndex
CREATE UNIQUE INDEX "LabourPunch_workerId_punchDate_type_key" ON "labour"."LabourPunch"("workerId", "punchDate", "type");

-- CreateIndex
CREATE INDEX "LabourPunchRefusal_companyId_idx" ON "labour"."LabourPunchRefusal"("companyId");

-- CreateIndex
CREATE INDEX "LabourPunchRefusal_companyId_siteId_createdAt_idx" ON "labour"."LabourPunchRefusal"("companyId", "siteId", "createdAt");

-- CreateIndex
CREATE INDEX "LabourPaymentSheet_companyId_siteId_idx" ON "labour"."LabourPaymentSheet"("companyId", "siteId");

