-- How each company numbers its projects, vendors, work orders, machines and assets — set in
-- Settings → Numbering (2026-10-15). The client: "Can we give a setting to configure the Project
-- Code, Vendor Code, Work Order Number, Plant and Machinery and Assets".
--
-- A company with no row for a series keeps the built-in format, which is Parth Realcon's: projects
-- 1010, 1020…; vendors 2022001…; work orders 1500001…; machines and assets JCB01/2027. So this adds
-- no rows; a row exists only once somebody changes a format.

CREATE TABLE "settings"."CodeFormat" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    -- PROJECTS, VENDORS, WORK_ORDER (a counted series), EQUIPMENT, ASSETS (named: letters from
    -- the name, a serial per prefix, the manufacturing year).
    "series" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "base" INTEGER NOT NULL DEFAULT 0,
    "step" INTEGER NOT NULL DEFAULT 1,
    "width" INTEGER NOT NULL DEFAULT 0,
    "separator" TEXT NOT NULL DEFAULT '/',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeFormat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeFormat_companyId_series_key" ON "settings"."CodeFormat"("companyId", "series");

ALTER TABLE "settings"."CodeFormat" ADD CONSTRAINT "CodeFormat_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "settings"."CodeFormat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."CodeFormat" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings"."CodeFormat"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = current_setting('app.current_company_id', true)
  );

-- An asset's code ends in its manufacturing year, as a machine's does (JCB01/2027).
ALTER TABLE "assets"."Asset" ADD COLUMN "manufacturingYear" INTEGER;
