-- 046: a site may have no weekly off (the client, 2026-10-27) — its O&M sites run every day.
-- Existing sites keep their day.

-- AlterTable
ALTER TABLE "projects"."Site" ALTER COLUMN "weeklyOffDay" DROP NOT NULL;
