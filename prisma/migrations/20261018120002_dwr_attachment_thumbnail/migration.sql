-- 036 B6/I8 (2026-10-18): DWR photos are compressed on upload (≤ 2048 px) and get a 320 px
-- thumbnail for the report's photo strip. Nullable: PDFs have none, and photos filed before this
-- are served full size by the thumbnail route instead.

-- AlterTable
ALTER TABLE "projects"."DWRAttachment" ADD COLUMN "thumbnailRef" TEXT;
