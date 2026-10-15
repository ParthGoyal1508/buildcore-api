-- An issue records the project it was issued for and the vendor or subcontractor who took it
-- (2026-10-15). The client: "while issuing material we want to give an option to select Project
-- and vendor or subcontractor".
--
-- Both optional and both plain columns, like `siteId` and `itemId`: the project lives in
-- `projects` and the vendor in `partners`, and Principle I keeps cross-module integrity in the
-- service layer. Existing issues keep NULL — what they were issued for was never recorded.

ALTER TABLE "inventory"."Issue" ADD COLUMN "projectId" TEXT;
ALTER TABLE "inventory"."Issue" ADD COLUMN "vendorId" TEXT;

CREATE INDEX "Issue_companyId_projectId_idx" ON "inventory"."Issue"("companyId", "projectId");
CREATE INDEX "Issue_companyId_vendorId_idx" ON "inventory"."Issue"("companyId", "vendorId");
