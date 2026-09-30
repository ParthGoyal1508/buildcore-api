-- 020 Phase 1, 2026-09-30. The acceptable GPS accuracy, per company (FR-012b).
--
-- The client's own words: "configurable from the settings by super admin". An environment variable
-- does not satisfy that — it needs a redeploy and it is the same for both companies.
--
-- Additive, no backfill, no data statement, so no `set_config` guard.
--
-- **Nullable and not defaulted**, deliberately. Null means "this company has not decided", which is
-- a different fact from "this company chose 50" — and only the first should follow a change to the
-- product default. A column defaulted to 50 would make every company look as though it had made a
-- decision nobody made, and the next person to change the default would silently change nothing.
ALTER TABLE "settings"."Company"
  ADD COLUMN "punchAccuracyMaxMetres" INTEGER;
