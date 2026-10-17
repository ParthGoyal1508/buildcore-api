-- 036 O4: a short payment is carried into the worker's next payment sheet as a line of its own.
-- `carriedFromLineId` names the earlier line whose shortfall the new line pays, so the same
-- shortfall is never carried twice and a reversal can see that it has been carried.
-- The table already has row-level security; a new column needs no policy of its own.

ALTER TABLE "labour"."PaymentSheetLine" ADD COLUMN "carriedFromLineId" TEXT;

CREATE INDEX "PaymentSheetLine_carriedFromLineId_idx" ON "labour"."PaymentSheetLine"("carriedFromLineId");
