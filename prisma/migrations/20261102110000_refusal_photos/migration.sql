-- 057: a refused punch keeps its photo for review, for a limited time (deleted by the retention sweep).
ALTER TABLE "hr"."PunchRefusal" ADD COLUMN "photoRef" TEXT;
ALTER TABLE "labour"."LabourPunchRefusal" ADD COLUMN "photoRef" TEXT;

-- The retention sweep finds photos past their age by these.
CREATE INDEX "PunchRecord_photo_retention_idx" ON "hr"."PunchRecord" ("capturedAt") WHERE "photoRef" IS NOT NULL;
CREATE INDEX "LabourPunch_photo_retention_idx" ON "labour"."LabourPunch" ("punchedAt") WHERE "photoRef" IS NOT NULL;
-- A labour punch's photo is also referenced from its muster line; the sweep clears both by ref.
CREATE INDEX "MusterLine_photoRef_idx" ON "labour"."MusterLine" ("photoRef") WHERE "photoRef" IS NOT NULL;
