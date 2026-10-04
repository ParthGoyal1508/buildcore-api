-- Project and company documents remember what they are and what they were called.
--
-- Both routes have always *received* a content type — `UploadProjectDocumentDto.contentType` and
-- its company-documents twin — and both threw it away: it was passed to the storage adapter,
-- which the local one ignores outright, and never written to the row. The download then served
-- every document as `application/octet-stream` under a filename with no extension
-- (`Bill-of-quantities-cmu40n3…`), so a PDF opened in a text editor as `%PDF-1.3 … endstream`.
-- The uploader's own file name was never recorded at all.
--
-- `EquipmentDocument` has carried `fileName` and `mimeType` since feature 006 and serves both on
-- download. This brings the other two document stores to the arrangement that already worked.
--
-- Both columns are nullable and there is no backfill, deliberately: the bytes are in object
-- storage and the only honest backfill would be a guess. The download sniffs the stored bytes
-- when `mimeType` is null instead — see `src/common/storage/file-type.ts` — so every document
-- filed before today opens correctly without this migration having to invent anything.

SELECT set_config('app.is_super_admin', 'true', true);

ALTER TABLE "projects"."ProjectDocument"
  ADD COLUMN "fileName" TEXT,
  ADD COLUMN "mimeType" TEXT;

ALTER TABLE "projects"."StagedProjectDocument"
  ADD COLUMN "fileName" TEXT,
  ADD COLUMN "mimeType" TEXT;

ALTER TABLE "settings"."CompanyDocument"
  ADD COLUMN "fileName" TEXT,
  ADD COLUMN "mimeType" TEXT;

COMMENT ON COLUMN "projects"."ProjectDocument"."mimeType" IS
  'Null for a document filed before 2026-10-04. The download sniffs the bytes in that case rather than serving octet-stream.';
