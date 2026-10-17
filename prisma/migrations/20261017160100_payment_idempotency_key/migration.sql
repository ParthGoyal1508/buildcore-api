-- 036 M10: duplicate-submit protection for vendor payments. A new, nullable column, so no existing
-- row can violate the index (NULLs are distinct in a Postgres unique index).
ALTER TABLE "inventory"."Payment" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Payment_companyId_idempotencyKey_key"
  ON "inventory"."Payment"("companyId", "idempotencyKey");
