-- 043 Site-initiated purchase entries. The site records a delivery as a partial purchase; Head
-- Office completes it with the vendor, quantity, rate and bill, and only then does stock move.
--
-- Every existing row is a Head Office purchase and already completed, which is what the two
-- defaults say — nothing about them changes.

-- CreateEnum
CREATE TYPE "inventory"."PurchaseSource" AS ENUM ('head_office', 'site');

-- CreateEnum
CREATE TYPE "inventory"."PurchaseStatus" AS ENUM ('partial_site', 'completed');

-- AlterTable
ALTER TABLE "inventory"."Purchase" ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedByUserId" TEXT,
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "geofenceDistanceMeters" DECIMAL(10,2),
ADD COLUMN     "gpsAccuracyMeters" DECIMAL(10,2),
ADD COLUMN     "gpsCapturedAt" TIMESTAMP(3),
ADD COLUMN     "gpsLatitude" DECIMAL(10,7),
ADD COLUMN     "gpsLongitude" DECIMAL(10,7),
ADD COLUMN     "source" "inventory"."PurchaseSource" NOT NULL DEFAULT 'head_office',
ADD COLUMN     "status" "inventory"."PurchaseStatus" NOT NULL DEFAULT 'completed',
ADD COLUMN     "vehicleNo" TEXT,
ALTER COLUMN "vendorId" DROP NOT NULL,
ALTER COLUMN "quantity" DROP NOT NULL,
ALTER COLUMN "rate" DROP NOT NULL,
ALTER COLUMN "amount" DROP NOT NULL;

-- The four columns are nullable only while a site entry waits for Head Office. A completed purchase
-- without them would be stock and a payable valued at nothing, so the database refuses it as well
-- as the service. Prisma cannot express a CHECK; it is kept here.
ALTER TABLE "inventory"."Purchase" ADD CONSTRAINT "Purchase_completed_has_terms_check"
  CHECK ("status" <> 'completed' OR ("vendorId" IS NOT NULL AND "quantity" IS NOT NULL AND "rate" IS NOT NULL AND "amount" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_clientRequestId_key" ON "inventory"."Purchase"("clientRequestId");

-- CreateIndex
CREATE INDEX "Purchase_companyId_status_idx" ON "inventory"."Purchase"("companyId", "status");

-- A site entry's change history is read beside it, by record (AuditLogService.listForEntity).
CREATE INDEX "AuditLogEntry_entityType_entityId_idx" ON "shared"."AuditLogEntry"("entityType", "entityId");

-- Site Incharge records site deliveries (the client, 2026-10-25: the Site In-charge who already marks
-- labour attendance does this as well), and Super Admin holds every permission, as each new one's
-- migration has granted it. Read and write, as every grant the standard roles carry.
SELECT set_config('app.is_super_admin', 'true', true);

INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt", "createdBy")
SELECT gen_random_uuid()::text, r."id", 'INVENTORY_SITE_ENTRY'::"settings"."Permission", levels."level", NOW(), 'migration:20261025100001_site_purchase_entries'
FROM "settings"."Role" r
CROSS JOIN (VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")) AS levels("level")
WHERE r."name" IN ('Site Incharge', 'Super Admin')
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

UPDATE "settings"."Role" r
SET "permissions" = array_append(r."permissions", 'INVENTORY_SITE_ENTRY'::"settings"."Permission"),
    "updatedAt" = NOW()
WHERE r."name" IN ('Site Incharge', 'Super Admin')
  AND NOT ('INVENTORY_SITE_ENTRY' = ANY (r."permissions"));
