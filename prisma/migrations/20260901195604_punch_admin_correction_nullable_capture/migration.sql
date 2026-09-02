-- CreateEnum
CREATE TYPE "hr"."AttendanceStatusOverride" AS ENUM ('present', 'absent', 'on_leave', 'weekly_off', 'holiday');

-- AlterTable
ALTER TABLE "hr"."PunchRecord" ADD COLUMN     "adminEdited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "editedByUserId" TEXT,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "statusOverride" "hr"."AttendanceStatusOverride",
ALTER COLUMN "photoRef" DROP NOT NULL,
ALTER COLUMN "faceMatchResult" DROP NOT NULL,
ALTER COLUMN "latitude" DROP NOT NULL,
ALTER COLUMN "longitude" DROP NOT NULL,
ALTER COLUMN "geofenceResult" DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Capture columns are optional in Prisma so feature 005's admin corrections
-- (source = 'admin_correction') can record attendance with no photo, no GPS and
-- no face match — an admin marking a day present was never at the site.
--
-- Relaxing the column for that case must not relax it for the case that matters.
-- A self-service punch without a photo or a geofence result would be an
-- unattributable attendance record, which is exactly what the biometric flow
-- exists to prevent, so the requirement is re-imposed here as a CHECK scoped to
-- employee-sourced rows. Prisma cannot express a conditional NOT NULL.
--
-- `legacy` rows predate FR-008 and are left unconstrained; they are historical and
-- no longer written.
ALTER TABLE "hr"."PunchRecord"
  ADD CONSTRAINT "PunchRecord_employee_capture_required"
  CHECK (
    "source" <> 'employee'
    OR (
      "photoRef" IS NOT NULL
      AND "faceMatchResult" IS NOT NULL
      AND "latitude" IS NOT NULL
      AND "longitude" IS NOT NULL
      AND "geofenceResult" IS NOT NULL
    )
  );
