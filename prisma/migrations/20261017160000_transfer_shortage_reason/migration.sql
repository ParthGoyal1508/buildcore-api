-- 036 M3: a transfer received short records why. Nullable and additive: transfers received before
-- this carry no reason, and a full receipt never needs one.
ALTER TABLE "inventory"."StockTransfer" ADD COLUMN "shortageReason" TEXT;
