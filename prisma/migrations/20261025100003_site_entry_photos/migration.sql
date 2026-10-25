-- 043 follow-up: a site delivery takes up to five photos (the client, 2026-10-25: "for some items we
-- take multiple photos, max 5"). The first stays in "photoFileRef", where every existing reader looks;
-- the rest are here, in the order taken. Existing rows get an empty list.

-- AlterTable
ALTER TABLE "inventory"."Purchase" ADD COLUMN     "extraPhotoFileRefs" TEXT[] DEFAULT ARRAY[]::TEXT[];
