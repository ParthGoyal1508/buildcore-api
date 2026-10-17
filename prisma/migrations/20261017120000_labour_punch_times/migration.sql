-- 034: labour attendance counted from punch times. Day rules on the company, a correction history,
-- reference group photos, and punches that a correction added (no photo or location).

-- CreateEnum
CREATE TYPE "labour"."LabourPunchSource" AS ENUM ('face', 'correction');

-- AlterEnum
ALTER TYPE "settings"."Permission" ADD VALUE 'LABOUR_PUNCH_CORRECT';

-- AlterTable
ALTER TABLE "settings"."Company" ADD COLUMN     "labourFullDayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
ADD COLUMN     "labourHalfDayHours" DECIMAL(4,2) NOT NULL DEFAULT 4,
ADD COLUMN     "labourStandardHours" DECIMAL(4,2) NOT NULL DEFAULT 8;

-- AlterTable
ALTER TABLE "labour"."LabourPunch" ADD COLUMN     "correctedAt" TIMESTAMP(3),
ADD COLUMN     "source" "labour"."LabourPunchSource" NOT NULL DEFAULT 'face',
ALTER COLUMN "photoRef" DROP NOT NULL,
ALTER COLUMN "faceMatchDistance" DROP NOT NULL,
ALTER COLUMN "latitude" DROP NOT NULL,
ALTER COLUMN "longitude" DROP NOT NULL,
ALTER COLUMN "geofenceDistanceMetres" DROP NOT NULL;

-- CreateTable
CREATE TABLE "labour"."LabourPunchCorrection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "punchDate" DATE NOT NULL,
    "type" "labour"."LabourPunchType" NOT NULL,
    "oldPunchedAt" TIMESTAMP(3),
    "newPunchedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabourPunchCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour"."LabourSitePhoto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "photoDate" DATE NOT NULL,
    "photoRef" TEXT NOT NULL,
    "note" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "takenById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabourSitePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabourPunchCorrection_companyId_idx" ON "labour"."LabourPunchCorrection"("companyId");

-- CreateIndex
CREATE INDEX "LabourPunchCorrection_workerId_punchDate_idx" ON "labour"."LabourPunchCorrection"("workerId", "punchDate");

-- CreateIndex
CREATE INDEX "LabourSitePhoto_companyId_idx" ON "labour"."LabourSitePhoto"("companyId");

-- CreateIndex
CREATE INDEX "LabourSitePhoto_companyId_siteId_photoDate_idx" ON "labour"."LabourSitePhoto"("companyId", "siteId", "photoDate");


-- Re-count face-punch days under the new rule (default thresholds 8 / 4 / 8 hours), except days a
-- payment sheet already covers, which were paid as they stood. Under 031 punch-in alone was a half
-- day; now a day without a punch-out is unresolved and not counted until it is corrected.
CREATE TEMP TABLE "_labour_day_034" ON COMMIT DROP AS
SELECT ml."id",
       EXTRACT(EPOCH FROM (po."punchedAt" - pi."punchedAt")) / 3600.0 AS hrs
FROM "labour"."MusterLine" ml
JOIN "labour"."MusterRoll" r ON r."id" = ml."musterId"
LEFT JOIN "labour"."LabourPunch" pi
  ON pi."workerId" = ml."workerId" AND pi."punchDate" = r."date" AND pi."type" = 'in'
LEFT JOIN "labour"."LabourPunch" po
  ON po."workerId" = ml."workerId" AND po."punchDate" = r."date" AND po."type" = 'out'
WHERE r."source" = 'face_punch'
  AND r."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "labour"."LabourPaymentSheet" s
    WHERE s."deletedAt" IS NULL
      AND s."companyId" = r."companyId"
      AND (s."siteId" = r."siteId" OR s."siteId" IS NULL)
      AND s."periodFrom" <= r."date" AND s."periodTo" >= r."date"
  );

DELETE FROM "labour"."MusterLine" ml
USING "_labour_day_034" d
WHERE ml."id" = d."id" AND (d.hrs IS NULL OR d.hrs <= 0);

UPDATE "labour"."MusterLine" ml
SET "attendanceType" = CASE
      WHEN d.hrs >= 8 THEN 'full_day'::"labour"."AttendanceType"
      WHEN d.hrs >= 4 THEN 'half_day'::"labour"."AttendanceType"
      ELSE 'absent'::"labour"."AttendanceType"
    END,
    "overtimeHours" = CASE WHEN d.hrs > 8 THEN ROUND((d.hrs - 8)::numeric, 2) ELSE NULL END
FROM "_labour_day_034" d
WHERE ml."id" = d."id" AND d.hrs > 0;
