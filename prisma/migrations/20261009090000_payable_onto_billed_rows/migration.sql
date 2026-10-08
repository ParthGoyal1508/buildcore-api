-- Carry an issued package's payable onto the bill row it issued. 2026-10-09.
--
-- No schema change, so there is nothing for `prisma migrate diff` to generate: this is a data
-- migration, written the way 20261007090000's was and for the same kind of reason.
--
-- 028 stopped the bill sheet writing `retentionAmount` and the net, making the package the only
-- store for a deduction — correctly. But a bill composed through a package never had them
-- written by anything else, so they stayed at zero and the net came out equal to the gross.
-- Three readers take that column at face value:
--
--   * the Subcontractors list, which showed RA-06 as ₹35,193.50 net while its own document said
--     ₹40,120.59;
--   * the Client bills list, the same one direction over;
--   * `bill-payments.service.ts`, which refuses a payment larger than the certified amount — so
--     paying the subcontractor what the bill actually says was rejected as an overpayment.
--
-- `issue` now copies both figures across at the moment it freezes them. This brings the rows
-- already issued into line with the documents that went out under them.
--
-- **Issued and certified only.** A draft package has nothing frozen to copy; its figures are
-- still being decided, and the view reports no payable at all until issue.
UPDATE "projects"."RABill" b
SET "retentionAmount" = p."retentionAmount",
    "netPayable"      = p."payable"
FROM "projects"."BillPackage" p
WHERE p."raBillId" = b."id"
  AND p."status" IN ('issued', 'certified');

UPDATE "projects"."ClientBill" c
SET "retentionAmount" = p."retentionAmount",
    "netAmount"       = p."payable"
FROM "projects"."BillPackage" p
WHERE p."clientBillId" = c."id"
  AND p."status" IN ('issued', 'certified');
