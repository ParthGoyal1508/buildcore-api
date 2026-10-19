-- 036 K14: equipment photos — an optional main photo plus a gallery, each stored compressed with
-- a 320 px thumbnail. A machine never needs a photo.
CREATE TABLE "plant"."EquipmentPhoto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "thumbnailRef" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileName" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EquipmentPhoto_companyId_idx" ON "plant"."EquipmentPhoto"("companyId");

CREATE INDEX "EquipmentPhoto_equipmentId_idx" ON "plant"."EquipmentPhoto"("equipmentId");

ALTER TABLE "plant"."EquipmentPhoto" ADD CONSTRAINT "EquipmentPhoto_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "plant"."Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one main photo per machine. Partial, so any number of gallery photos sit beside it;
-- Prisma cannot express a partial unique index, so it lives only here.
CREATE UNIQUE INDEX "EquipmentPhoto_one_main_per_equipment"
  ON "plant"."EquipmentPhoto"("equipmentId") WHERE "isMain";

-- The standard tenant policy every plant table carries (20260904081330_plant_rls_policies).
ALTER TABLE "plant"."EquipmentPhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plant"."EquipmentPhoto" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plant"."EquipmentPhoto"
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR current_setting('app.is_super_admin', true) = 'true'
  );
