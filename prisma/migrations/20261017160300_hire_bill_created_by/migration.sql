-- 036 K8: maker-checker on hire bills needs to know who raised each one.
ALTER TABLE "plant"."HireBill" ADD COLUMN "createdByUserId" TEXT;

-- Existing bills: the account on the bill's CREATE audit entry, which HireBillsService.create has
-- always written. A bill with no such entry stays null and is verifiable by anyone, as before.
UPDATE "plant"."HireBill" h
SET "createdByUserId" = a."accountId"
FROM (
  SELECT DISTINCT ON ("entityId") "entityId", "accountId"
  FROM "shared"."AuditLogEntry"
  WHERE "entityType" = 'HIRE_BILL' AND "action" = 'CREATE' AND "accountId" IS NOT NULL
  ORDER BY "entityId", "createdAt" ASC
) a
WHERE a."entityId" = h."id" AND h."createdByUserId" IS NULL;
