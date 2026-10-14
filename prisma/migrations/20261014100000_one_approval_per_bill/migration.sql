-- One bill, one approval (2026-10-14).
--
-- A bill raised through a bill package is approved on the package (`client_bill` / `ra_bill` chain
-- against `bill_package`). The Subcontractors tab still offered the old sheet's "Submit", which put
-- the RA bill under it into a second, unrelated `ra_bill` approval. The API now refuses that; this
-- closes the ones already raised, the way `ApprovalService.abandon` does, so nobody is left asked
-- to decide them.
UPDATE "shared"."ApprovalInstance" i
SET "state" = 'abandoned',
    "delegatedToUserId" = NULL,
    "delegationReason" = 'Superseded: this bill is approved on its bill package.'
FROM "projects"."BillPackage" p
WHERE i."entityType" = 'ra_bill'
  AND i."entityId" = p."raBillId"
  AND i."state" IN ('pending', 'returned');

-- And the RA bill those submits moved to `submitted` goes back to draft wherever its package has not
-- been issued — issue is what moves it now, and "Submitted" beside a draft package reads as an
-- approval that does not exist.
UPDATE "projects"."RABill" rb
SET "status" = 'draft', "submittedAt" = NULL
FROM "projects"."BillPackage" p
WHERE p."raBillId" = rb."id"
  AND rb."status" = 'submitted'
  AND p."status" IN ('draft', 'pending_approval', 'approved');
