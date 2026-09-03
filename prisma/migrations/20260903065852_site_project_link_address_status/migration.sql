-- Feature 008, step 1 of 2: extend 003's existing `projects.Site` in place.
--
-- Additive only. Every column added here is nullable or defaulted, so the rows 003
-- already created stay valid without a backfill, and 003's own columns
-- (latitude/longitude/geofenceRadiusMeters/weeklyOffDay) are untouched — HR reads
-- them through SitesService on every punch (Constitution Principle VI, safe
-- migrations; plan.md "Site's extension is additive").
--
-- `projectId`'s FOREIGN KEY is deliberately NOT declared here: `projects.Project`
-- does not exist until step 2. The column lands now so the two migrations stay in
-- the order tasks.md T008 asks for, and the constraint is added alongside the table
-- it references.

CREATE TYPE "projects"."SiteStatus" AS ENUM ('active', 'inactive');

ALTER TABLE "projects"."Site"
  ADD COLUMN "address"   TEXT,
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "status"    "projects"."SiteStatus" NOT NULL DEFAULT 'active';

CREATE INDEX "Site_projectId_idx" ON "projects"."Site"("projectId");
