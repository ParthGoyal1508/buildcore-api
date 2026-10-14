-- How the company is reached, printed at the head of a work order or purchase order (2026-10-14).
ALTER TABLE "settings"."Company" ADD COLUMN "phone" TEXT;
ALTER TABLE "settings"."Company" ADD COLUMN "email" TEXT;
ALTER TABLE "settings"."Company" ADD COLUMN "website" TEXT;
