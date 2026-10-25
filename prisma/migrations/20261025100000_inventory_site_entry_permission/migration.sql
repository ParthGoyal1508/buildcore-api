-- 043 Site-initiated purchase entries: the permission for the site's "Create Inventory Purchase" page.
--
-- Alone in its migration because Postgres refuses a new enum value inside the transaction that
-- added it; the grant that uses it is in the next migration.
ALTER TYPE "settings"."Permission" ADD VALUE 'INVENTORY_SITE_ENTRY';
