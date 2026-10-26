-- 045: CNG as a power source, and the issue date of a registration paper (the client, 2026-10-26).
-- Existing machines keep their power source; existing papers get no issue date.

-- AlterEnum
ALTER TYPE "plant"."PowerSource" ADD VALUE 'cng';

-- AlterTable
ALTER TABLE "plant"."EquipmentRegistrationItem" ADD COLUMN     "issuedAt" DATE;
