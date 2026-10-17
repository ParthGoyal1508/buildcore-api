-- 036 K4: the stated reason when a logbook entry's opening reading does not follow on from the
-- previous entry's closing one. Nullable and additive.
ALTER TABLE "plant"."LogbookEntry" ADD COLUMN "readingGapReason" TEXT;
